import Foundation
import XCTest
@testable import CompanionCore

private final class PushRequestStub: URLProtocol {
    static var responseBody = Data()
    static var statusCode = 200
    static var capturedRequest: URLRequest?
    static var capturedBody: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.capturedRequest = request
        Self.capturedBody = Self.readBody(from: request)
        let response = HTTPURLResponse(
            url: request.url!, statusCode: Self.statusCode, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseBody)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func readBody(from request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count >= 0 else { return nil }
            if count == 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

final class PushTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        PushRequestStub.capturedRequest = nil
        PushRequestStub.capturedBody = nil
        PushRequestStub.statusCode = 200
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PushRequestStub.self]
        session = URLSession(configuration: configuration)
        client = CompanionClient(connection: Connection(name: "fixture", host: "127.0.0.1", port: 8810), token: "fixture-pairing", session: session)
    }

    override func tearDown() {
        session.invalidateAndCancel()
        super.tearDown()
    }

    func testPoppyEnvelopeRequiresKind() {
        let reference: [String: Any] = ["itemId": "opaque", "revision": 1]
        XCTAssertNil(NotificationTarget(notificationPayload: ["poppyInterface": 1, "poppy": reference]))
        XCTAssertNil(NotificationTarget(notificationPayload: ["poppyInterface": 1, "kind": "done", "poppy": reference]))
    }

    func testVariableLengthNativeTokenAndProjectIdentity() throws {
        let registration = try XCTUnwrap(PushRegistration(deviceToken: Data([0, 15, 255]), bundleId: "com.openmausbot.app", environment: .development))
        XCTAssertEqual(registration.token, "000fff")
        XCTAssertEqual(registration.tokenDigest.count, 64)
        XCTAssertNil(PushRegistration(deviceToken: Data(), bundleId: "com.openmausbot.app", environment: .development))
        XCTAssertNil(PushRegistration(deviceToken: Data(repeating: 1, count: 513), bundleId: "com.openmausbot.app", environment: .development))
        XCTAssertNil(PushRegistration(deviceToken: Data([1]), bundleId: "other.app", environment: .production))
    }

    func testPushRegistrationUsesPairedBearerAndNoCallerDeviceID() async throws {
        let registration = try XCTUnwrap(PushRegistration(deviceToken: Data([0, 15, 255]), bundleId: "com.openmausbot.app", environment: .production))
        PushRequestStub.responseBody = try JSONSerialization.data(withJSONObject: ["registered": true, "tokenDigest": registration.tokenDigest])
        try await client.registerPush(registration)
        let request = try XCTUnwrap(PushRequestStub.capturedRequest)
        XCTAssertEqual(request.url?.path, "/api/companion/v1/push")
        XCTAssertEqual(request.httpMethod, "PUT")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-pairing")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(PushRequestStub.capturedBody)) as? [String: String])
        XCTAssertEqual(body, ["token": "000fff", "bundleId": "com.openmausbot.app", "environment": "production"])
        PushRequestStub.responseBody = Data(#"{"registered":true,"tokenDigest":"wrong"}"#.utf8)
        do { try await client.registerPush(registration); XCTFail("mismatched token acknowledgement") } catch {}
        PushRequestStub.statusCode = 401
        do { try await client.registerPush(registration); XCTFail("revoked pairing") } catch let error as APIError { XCTAssertTrue(error.isUnauthorized) }
    }

    func testDenialRemovesOnlyCurrentAuthenticatedRegistration() async throws {
        PushRequestStub.responseBody = Data(#"{"registered":false}"#.utf8)
        try await client.unregisterPush()
        XCTAssertEqual(PushRequestStub.capturedRequest?.httpMethod, "DELETE")
        XCTAssertEqual(PushRequestStub.capturedRequest?.url?.path, "/api/companion/v1/push")
        XCTAssertNil(PushRequestStub.capturedBody)
    }

    func testPushAcceptsOnlyVersionedOpaqueReference() throws {
        let payload: [AnyHashable: Any] = ["kind": "poppy", "poppyInterface": 1, "poppy": ["itemId": "alias-1", "revision": 2]]
        let target = try XCTUnwrap(NotificationTarget(notificationPayload: payload))
        XCTAssertEqual(target.poppy?.itemId, "alias-1")
        XCTAssertEqual(target.botId, "")
        for replacement in [0, -1] {
            var invalid = payload
            invalid["poppy"] = ["itemId": "alias-1", "revision": replacement]
            XCTAssertNil(NotificationTarget(notificationPayload: invalid))
        }
        for version: Any in [2, true, "1"] {
            var invalid = payload
            invalid["poppyInterface"] = version
            XCTAssertNil(NotificationTarget(notificationPayload: invalid))
        }
        XCTAssertNil(NotificationTarget(notificationPayload: ["kind": "poppy", "botId": "raw", "threadId": "raw"]))
        XCTAssertNil(PoppyNotificationReference(itemId: "../another-task", revision: 1))
    }

    func testTapFetchesCurrentAliasAndRejectsWrongOrOlderItem() async throws {
        PushRequestStub.responseBody = Data(#"{"id":"alias-1","revision":3,"botId":"poppy-bot","threadId":"exact-task"}"#.utf8)
        let item = try await client.poppyItem(id: "alias-1")
        let reference = try XCTUnwrap(PoppyNotificationReference(itemId: "alias-1", revision: 2))
        XCTAssertEqual(item.target(for: reference)?.threadId, "exact-task")
        XCTAssertNil(item.target(for: PoppyNotificationReference(itemId: "alias-1", revision: 4)!))
        XCTAssertNil(item.target(for: PoppyNotificationReference(itemId: "other", revision: 2)!))
        XCTAssertEqual(PushRequestStub.capturedRequest?.url?.path, "/api/poppy/v1/items/alias-1")
        PushRequestStub.capturedRequest = nil
        do { _ = try await client.poppyItem(id: "../another"); XCTFail("path traversal") } catch {}
        XCTAssertNil(PushRequestStub.capturedRequest)
    }

    func testPoppyStreamNeverCreatesALocalAlertIncludingReplay() throws {
        let json = #"{"kind":"poppy","botId":"poppy","botName":"Private","threadId":"task","title":"Sensitive","body":"Private","poppy":{"itemId":"alias","revision":1}}"#
        let frame = try JSONDecoder().decode(NotificationFrame.self, from: Data(json.utf8))
        XCTAssertFalse(frame.shouldDeliverLocalAlert)
        var legacyKind = frame
        legacyKind.kind = "done"
        XCTAssertFalse(legacyKind.shouldDeliverLocalAlert)
        legacyKind.poppy = nil
        XCTAssertTrue(legacyKind.shouldDeliverLocalAlert)
    }

    func testUnknownPoppyInterfaceMarkerSuppressesLegacyLocalAlert() throws {
        let json = #"{"kind":"done","botId":"unknown","botName":"Unhydrated","threadId":"task","title":"Private","body":"Private","poppyInterface":99}"#
        let frame = try JSONDecoder().decode(NotificationFrame.self, from: Data(json.utf8))
        XCTAssertTrue(frame.hasPoppyInterfaceMarker)
        XCTAssertFalse(frame.shouldDeliverLocalAlert)
    }

    func testLegacyLocalAlertRequiresKnownNonPoppyProfile() {
        let frame = NotificationFrame(
            kind: "done", botId: "legacy", botName: "Legacy", threadId: "task",
            title: "Generic", body: "Generic"
        )
        XCTAssertFalse(frame.shouldDeliverLegacyLocalAlert(isPoppy: nil))
        XCTAssertFalse(frame.shouldDeliverLegacyLocalAlert(isPoppy: true))
        XCTAssertTrue(frame.shouldDeliverLegacyLocalAlert(isPoppy: false))
    }
}
