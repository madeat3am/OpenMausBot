// What is attached to the next message, and how it got there.
//
// The desktop attaches a file or a folder by path, because the bot runs on
// that same disk. Everything on the phone has to travel: a picked file is
// copied out of its security-scoped URL into our own temp inbox the moment
// it is chosen (the picker's URL is only good for that moment), a folder is
// copied file by file with its structure kept, and the copies are uploaded
// when the message is sent. The chips above the composer are these copies.
import SwiftUI
import UniformTypeIdentifiers

struct PendingAttachment: Identifiable, Hashable {
    enum Kind: Hashable {
        case image
        case file
        case folder
    }

    let id: UUID
    let kind: Kind
    let name: String
    /// The copy in our inbox: a file, or the root of a rebuilt folder.
    let url: URL
    let bytes: Int
    let mime: String
    /// Regular files inside a folder; 1 for a file.
    let fileCount: Int

    var subtitle: String {
        switch kind {
        case .folder:
            return "\(fileCount) file\(fileCount == 1 ? "" : "s") · \(AttachmentIntake.formatSize(bytes))"
        case .image, .file:
            return AttachmentIntake.formatSize(bytes)
        }
    }

    var systemImage: String {
        switch kind {
        case .image: return "photo"
        case .file: return "doc"
        case .folder: return "folder"
        }
    }
}

enum AttachmentIntake {
    /// The server's ceilings, checked here so a too-big pick is refused
    /// before a single byte is copied rather than after the upload fails.
    static let fileLimitBytes = 25 * 1_024 * 1_024
    static let folderLimitBytes = 200 * 1_024 * 1_024
    static let folderFileLimit = 500
    /// The desktop's image types; anything else is an ordinary file.
    private static let imageMimes: Set<String> = ["image/png", "image/jpeg", "image/gif", "image/webp"]

    enum IntakeError: LocalizedError {
        case unreadable(String)
        case empty(String)
        case tooLarge(String, Int)
        case tooManyFiles(String, Int)
        case nothingInside(String)

        var errorDescription: String? {
            switch self {
            case let .unreadable(name): return "\(name) couldn't be read."
            case let .empty(name): return "\(name) is empty."
            case let .tooLarge(name, mb): return "\(name) is larger than \(mb) MB."
            case let .tooManyFiles(name, limit): return "\(name) has more than \(limit) files."
            case let .nothingInside(name): return "\(name) has no files to attach."
            }
        }
    }

    /// Files from the document picker. Each is copied now, while the
    /// picker's grant on it is still valid.
    static func takeFiles(_ sources: [URL]) throws -> [PendingAttachment] {
        try sources.map { source in
            let accessed = source.startAccessingSecurityScopedResource()
            defer { if accessed { source.stopAccessingSecurityScopedResource() } }
            let name = source.lastPathComponent
            let attributes = try FileManager.default.attributesOfItem(atPath: source.path)
            guard attributes[.type] as? FileAttributeType == .typeRegular else {
                throw IntakeError.unreadable(name)
            }
            let bytes = (attributes[.size] as? NSNumber)?.intValue ?? 0
            guard bytes > 0 else { throw IntakeError.empty(name) }
            guard bytes <= fileLimitBytes else { throw IntakeError.tooLarge(name, fileLimitBytes / 1_048_576) }
            let id = UUID()
            let destination = try inbox(for: id).appendingPathComponent(name)
            try FileManager.default.copyItem(at: source, to: destination)
            let mime = mimeFor(source)
            return PendingAttachment(
                id: id, kind: imageMimes.contains(mime) ? .image : .file, name: name,
                url: destination, bytes: bytes, mime: mime, fileCount: 1
            )
        }
    }

    /// A folder from the document picker, copied with its structure. Hidden
    /// files and packages' insides are skipped; an empty file is skipped
    /// too, since the server refuses one and it says nothing anyway.
    static func takeFolder(_ source: URL) throws -> PendingAttachment {
        let accessed = source.startAccessingSecurityScopedResource()
        defer { if accessed { source.stopAccessingSecurityScopedResource() } }
        let name = source.lastPathComponent
        let id = UUID()
        let root = try inbox(for: id).appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey, .isDirectoryKey]
        guard let walker = FileManager.default.enumerator(
            at: source, includingPropertiesForKeys: keys,
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { throw IntakeError.unreadable(name) }

        var count = 0
        var bytes = 0
        let base = source.standardizedFileURL.path
        for case let file as URL in walker {
            let values = try file.resourceValues(forKeys: Set(keys))
            guard values.isRegularFile == true else { continue }
            let size = values.fileSize ?? 0
            guard size > 0 else { continue }
            guard size <= fileLimitBytes else {
                throw IntakeError.tooLarge(file.lastPathComponent, fileLimitBytes / 1_048_576)
            }
            count += 1
            bytes += size
            guard count <= folderFileLimit else { throw IntakeError.tooManyFiles(name, folderFileLimit) }
            guard bytes <= folderLimitBytes else { throw IntakeError.tooLarge(name, folderLimitBytes / 1_048_576) }
            let full = file.standardizedFileURL.path
            guard full.hasPrefix(base + "/") else { continue }
            let relative = String(full.dropFirst(base.count + 1))
            let destination = root.appendingPathComponent(relative)
            try FileManager.default.createDirectory(
                at: destination.deletingLastPathComponent(), withIntermediateDirectories: true
            )
            try FileManager.default.copyItem(at: file, to: destination)
        }
        guard count > 0 else {
            discard(root.deletingLastPathComponent())
            throw IntakeError.nothingInside(name)
        }
        return PendingAttachment(
            id: id, kind: .folder, name: name, url: root, bytes: bytes,
            mime: "inode/directory", fileCount: count
        )
    }

    /// Every regular file under a rebuilt folder, as (relative path, url).
    static func files(in folder: PendingAttachment) -> [(relativePath: String, url: URL)] {
        guard folder.kind == .folder,
              let walker = FileManager.default.enumerator(
                at: folder.url, includingPropertiesForKeys: [.isRegularFileKey], options: [.skipsHiddenFiles]
              )
        else { return [] }
        let base = folder.url.standardizedFileURL.path
        var out: [(String, URL)] = []
        for case let file as URL in walker {
            guard (try? file.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true else { continue }
            let full = file.standardizedFileURL.path
            guard full.hasPrefix(base + "/") else { continue }
            out.append((String(full.dropFirst(base.count + 1)), file))
        }
        return out.sorted { $0.0 < $1.0 }
    }

    static func discard(_ attachment: PendingAttachment) {
        discard(attachment.url.deletingLastPathComponent())
    }

    private static func discard(_ inbox: URL) {
        try? FileManager.default.removeItem(at: inbox)
    }

    private static func inbox(for id: UUID) throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("composer-\(id.uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private static func mimeFor(_ url: URL) -> String {
        UTType(filenameExtension: url.pathExtension)?.preferredMIMEType?.lowercased() ?? "application/octet-stream"
    }

    static func formatSize(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}

/// The chips above the composer: one per pending attachment, each with a
/// way off.
struct PendingAttachmentChips: View {
    let items: [PendingAttachment]
    let onRemove: (PendingAttachment) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(items) { item in
                    HStack(spacing: 6) {
                        Image(systemName: item.systemImage)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Color.secondary)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(item.name)
                                .font(.system(size: 13, weight: .medium))
                                .lineLimit(1)
                            Text(item.subtitle)
                                .font(.system(size: 11))
                                .foregroundStyle(Color.secondary)
                        }
                        .frame(maxWidth: 160, alignment: .leading)
                        Button {
                            onRemove(item)
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 15))
                                .foregroundStyle(Color.secondary)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Remove \(item.name)")
                    }
                    .padding(.leading, 10)
                    .padding(.trailing, 6)
                    .padding(.vertical, 6)
                    .background(Color.secondary.opacity(0.12), in: Capsule())
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(item.kind == .folder ? "Folder" : "File"): \(item.name), \(item.subtitle)")
                }
            }
            .padding(.horizontal, 4)
        }
    }
}
