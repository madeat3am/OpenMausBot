import Foundation
import CryptoKit

public enum PushEnvironment: String, Codable, Sendable {
    case development, production
}

/// Transport identity only. The paired bearer, never this body, selects the device.
public struct PushRegistration: Encodable, Equatable, Sendable {
    public let token: String
    public let bundleId: String
    public let environment: PushEnvironment

    public var tokenDigest: String {
        SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    public init?(deviceToken: Data, bundleId: String, environment: PushEnvironment) {
        guard !deviceToken.isEmpty, deviceToken.count <= 512,
              bundleId == "com.openmausbot.app" else { return nil }
        token = deviceToken.map { String(format: "%02x", $0) }.joined()
        self.bundleId = bundleId
        self.environment = environment
    }
}

public struct PoppyNotificationReference: Codable, Hashable, Sendable {
    public let itemId: String
    public let revision: Int

    public init?(itemId: String, revision: Int) {
        guard Self.validID(itemId), revision > 0 else { return nil }
        self.itemId = itemId
        self.revision = revision
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let id = try values.decode(String.self, forKey: .itemId)
        let revision = try values.decode(Int.self, forKey: .revision)
        guard let reference = Self(itemId: id, revision: revision) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Invalid Poppy reference"))
        }
        self = reference
    }

    static func validID(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 256 && value.utf8.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) ||
                (97...122).contains($0) || $0 == 95 || $0 == 45
        }
    }
}

/// Only the authoritative navigation fields are needed when opening a push.
/// Unknown fields stay on the server; no approval can execute from this type.
public struct PoppyItemDestination: Decodable, Sendable {
    public let id: String
    public let revision: Int
    public let botId: String
    public let threadId: String

    public func target(for reference: PoppyNotificationReference) -> NotificationTarget? {
        guard id == reference.itemId, revision >= reference.revision,
              PoppyNotificationReference.validID(botId),
              PoppyNotificationReference.validID(threadId) else { return nil }
        return NotificationTarget(botId: botId, threadId: threadId, poppy: reference)
    }
}
