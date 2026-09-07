import Foundation
import XCTest
@testable import CompanionCore

final class UnsentDraftTests: XCTestCase {
    func testActualStoreFailureAndUnavailableDraftRefuseContentDiscardOnTopicChange() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        XCTAssertTrue(FileManager.default.createFile(atPath: file.path, contents: Data()))
        let store = UnsentDraftStore(directory: file)
        let draft = UnsentDraft(text: "Keep this typed reply", attachments: [])

        let outcome: DraftPersistenceOutcome
        do {
            try store.save(draft, connectionID: "pair", threadID: "old-topic")
            outcome = .saved(draft)
        } catch {
            outcome = .failed
        }

        XCTAssertEqual(outcome, .failed)
        XCTAssertFalse(outcome.permitsTopicChange(hasComposerContent: true))
        XCTAssertFalse(DraftPersistenceOutcome.unavailable.permitsTopicChange(hasComposerContent: true))
        XCTAssertTrue(DraftPersistenceOutcome.unavailable.permitsTopicChange(hasComposerContent: false))
        XCTAssertTrue(DraftPersistenceOutcome.notLoaded.permitsTopicChange(hasComposerContent: true))
        XCTAssertTrue(DraftPersistenceOutcome.cleared.permitsTopicChange(hasComposerContent: false))
    }

    func testRestartRetainsBytesAndRequestIdentityWithoutCrossingTopicsOrPairings() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let draft = UnsentDraft(text: "Internal fixture only", attachments: [
            PendingMessageAttachment(data: Data("fixture".utf8), name: "fixture.txt", mime: "text/plain", kind: .file)
        ])
        try UnsentDraftStore(directory: directory).save(draft, connectionID: "pairing-1", threadID: "task-1")
        let restarted = UnsentDraftStore(directory: directory)
        XCTAssertEqual(try restarted.load(connectionID: "pairing-1", threadID: "task-1"), draft)
        XCTAssertNil(try restarted.load(connectionID: "pairing-2", threadID: "task-1"))
        XCTAssertNil(try restarted.load(connectionID: "pairing-1", threadID: "task-2"))
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        XCTAssertEqual(files.count, 1)
        XCTAssertFalse(files[0].lastPathComponent.contains("task"))
        let mode = try FileManager.default.attributesOfItem(atPath: files[0].path)[.posixPermissions] as? Int
        XCTAssertEqual(mode, 0o600)
        try restarted.remove(connectionID: "pairing-1", threadID: "task-1")
        XCTAssertNil(try restarted.load(connectionID: "pairing-1", threadID: "task-1"))
    }

    func testInvalidAttachmentCannotOverwriteRetainedDraft() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = UnsentDraftStore(directory: directory)
        let original = UnsentDraft(text: "Keep this unsent", attachments: [])
        try store.save(original, connectionID: "pair", threadID: "task")
        let invalid = UnsentDraft(text: "invalid", attachments: [
            PendingMessageAttachment(data: Data([1]), name: "file.exe", mime: "application/x-executable", kind: .file)
        ])
        XCTAssertThrowsError(try store.save(invalid, connectionID: "pair", threadID: "task"))
        XCTAssertEqual(try store.load(connectionID: "pair", threadID: "task"), original)
    }
}
