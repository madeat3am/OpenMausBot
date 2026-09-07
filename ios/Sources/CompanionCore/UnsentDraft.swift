import Foundation
import CryptoKit

/// Local content, never a send queue. Only an explicit online Send consumes it.
public struct UnsentDraft: Codable, Equatable, Sendable {
    public let text: String
    public let attachments: [PendingMessageAttachment]
    public let requestID: String

    public init(text: String, attachments: [PendingMessageAttachment], requestID: String = UUID().uuidString) {
        self.text = text
        self.attachments = attachments
        self.requestID = requestID
    }
}

public struct UnsentDraftStore {
    public let directory: URL

    public init(directory: URL) { self.directory = directory }

    private func file(connectionID: String, threadID: String) throws -> URL {
        guard !connectionID.isEmpty, !threadID.isEmpty else { throw APIError.badURL }
        let identity = try JSONEncoder().encode([connectionID, threadID])
        let name = SHA256.hash(data: identity).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(name + ".json")
    }

    public func load(connectionID: String, threadID: String) throws -> UnsentDraft? {
        let url = try file(connectionID: connectionID, threadID: threadID)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? Int.max
        guard size <= 72 * 1_024 * 1_024 else { throw AttachmentPolicyError.totalTooLarge }
        let draft = try JSONDecoder().decode(UnsentDraft.self, from: Data(contentsOf: url))
        try AttachmentPolicy.validate(draft.attachments)
        return draft
    }

    public func save(_ draft: UnsentDraft, connectionID: String, threadID: String) throws {
        try AttachmentPolicy.validate(draft.attachments)
        let url = try file(connectionID: connectionID, threadID: threadID)
        let manager = FileManager.default
        try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var excluded = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try excluded.setResourceValues(values)
        let data = try JSONEncoder().encode(draft)
        guard data.count <= 72 * 1_024 * 1_024 else { throw AttachmentPolicyError.totalTooLarge }
#if os(iOS)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
#else
        try data.write(to: url, options: .atomic)
#endif
        try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    public func remove(connectionID: String, threadID: String) throws {
        let url = try file(connectionID: connectionID, threadID: threadID)
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    }
}
