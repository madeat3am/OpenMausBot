import CompanionCore
import QuickLook
import SwiftUI
import UIKit

enum AttachmentImportError: LocalizedError {
    case unreadable(String)
    case unsupported(String)
    case tooLarge(String, Int)

    var errorDescription: String? {
        switch self {
        case let .unreadable(name):
            return "OpenMausBot couldn't read \(name). Try exporting it to Files first."
        case let .unsupported(name):
            return "\(name) isn't a supported attachment. Try an image, PDF, text, Word, Excel, or PowerPoint file."
        case let .tooLarge(name, bytes):
            let limit = ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
            return "\(name) is larger than the \(limit) remaining attachment limit."
        }
    }
}

struct PendingAttachmentChip: View {
    let attachment: PendingMessageAttachment
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            preview

            VStack(alignment: .leading, spacing: 1) {
                Text(attachment.name)
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
                Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.data.count), countStyle: .file))
                    .font(.system(size: 11))
                    .foregroundStyle(Color.secondary)
            }

            Button(action: remove) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(Color.secondary)
                    .frame(width: 24, height: 24)
                    .background(Color.secondary.opacity(0.12), in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(attachment.name)")
        }
        .padding(.leading, 7)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
        .frame(maxWidth: 280, alignment: .leading)
        .background(Color.secondary.opacity(0.10), in: RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(Color.secondary.opacity(0.10))
        )
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var preview: some View {
        if attachment.kind == .image, let image = UIImage(data: attachment.data) {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: 34, height: 34)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .accessibilityHidden(true)
        } else {
            Image(systemName: "doc.fill")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Color.accentColor)
                .frame(width: 34, height: 34)
                .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                .accessibilityHidden(true)
        }
    }
}

struct FilePreviewItem: Identifiable {
    enum Kind { case markdown, text, quickLook }

    let id = UUID()
    let url: URL
    let filename: String
    let contentType: String
    let data: Data

    init?(downloaded: DownloadedFile) {
        guard let localURL = downloaded.localURL else { return nil }
        data = downloaded.data
        filename = downloaded.filename
        contentType = downloaded.contentType
        url = localURL
    }

    var kind: Kind {
        let mime = contentType.lowercased()
        let suffix = url.pathExtension.lowercased()
        if mime == "text/markdown" || suffix == "md" || suffix == "markdown" {
            return .markdown
        }
        if mime.hasPrefix("text/") || mime == "application/json" {
            return .text
        }
        return .quickLook
    }

    var text: String {
        let limit = 2 * 1_024 * 1_024
        let visible = data.prefix(limit)
        var decoded = String(decoding: visible, as: UTF8.self)
        if data.count > limit {
            decoded += "\n\n— Preview truncated. Share or open the file to read the rest. —"
        }
        return decoded
    }

    func cleanUp() {
        let directory = url.deletingLastPathComponent()
        if directory.deletingLastPathComponent().lastPathComponent == "OpenMausBotFilePreviews" {
            try? FileManager.default.removeItem(at: directory)
        } else {
            try? FileManager.default.removeItem(at: url)
        }
    }
}

struct FilePreviewView: View {
    let item: FilePreviewItem
    let close: () -> Void
    @State private var linkError: String?

    var body: some View {
        NavigationStack {
            Group {
                switch item.kind {
                case .markdown:
                    ScrollView {
                        MarkdownText(source: item.text, openLink: openPreviewLink)
                            .textSelection(.enabled)
                            .frame(maxWidth: 900, alignment: .leading)
                            .frame(maxWidth: .infinity, alignment: .top)
                            .padding(20)
                    }
                case .text:
                    ScrollView([.horizontal, .vertical]) {
                        Text(item.text)
                            .font(.system(size: 14, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                            .padding(20)
                    }
                case .quickLook:
                    QuickLookPreview(url: item.url)
                        .ignoresSafeArea(edges: .bottom)
                }
            }
            .background(Color(uiColor: .systemBackground))
            .navigationTitle(item.filename)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done", action: close)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: item.url) {
                        Image(systemName: "square.and.arrow.up")
                    }
                    .accessibilityLabel("Share \(item.filename)")
                }
            }
        }
        .onDisappear { item.cleanUp() }
        .alert("Couldn't open link", isPresented: Binding(
            get: { linkError != nil },
            set: { if !$0 { linkError = nil } }
        )) {
            Button("OK", role: .cancel) { linkError = nil }
        } message: {
            Text(linkError ?? "That link couldn't be opened.")
        }
    }

    private func openPreviewLink(_ url: URL) -> OpenURLAction.Result {
        guard let scheme = url.scheme?.lowercased(),
              (scheme == "http" || scheme == "https"),
              url.host != nil
        else {
            linkError = "Open links to other computer files from the original chat message."
            return .handled
        }
        return .systemAction(url)
    }
}

private struct QuickLookPreview: UIViewControllerRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: QLPreviewController, context: Context) {
        context.coordinator.url = url
        controller.reloadData()
    }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var url: URL

        init(url: URL) { self.url = url }

        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

        func previewController(
            _ controller: QLPreviewController,
            previewItemAt index: Int
        ) -> QLPreviewItem {
            url as NSURL
        }
    }
}
