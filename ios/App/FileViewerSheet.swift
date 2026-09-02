// A file the bot linked, opened on the phone.
//
// The desktop turns a linked file into a "save a copy" button because the
// file is already on that disk. Here the bytes come from the Mac over the
// pairing connection, and what the person wanted was to read the thing: a
// markdown report renders as a reply would, text and code show as text,
// and everything else goes to QuickLook, which knows PDFs, images and
// Office documents. The share button is the "save a copy" half — it offers
// Save to Files along with everything else the share sheet does.
import QuickLook
import SwiftUI
import CompanionCore

struct FileViewRequest: Identifiable {
    let id = UUID()
    let path: String
}

struct FileViewerSheet: View {
    let path: String
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var phase: Phase = .loading

    private enum Phase {
        case loading
        case failed(String)
        case loaded(FetchedFile, URL)
    }

    private var title: String { URL(fileURLWithPath: path).lastPathComponent }

    var body: some View {
        NavigationStack {
            Group {
                switch phase {
                case .loading:
                    ProgressView("Fetching from your computer…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                case let .failed(reason):
                    ContentUnavailableView(
                        "Couldn't open this file",
                        systemImage: "doc.questionmark",
                        description: Text(reason)
                    )
                case let .loaded(file, url):
                    content(file, url)
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                if case let .loaded(_, url) = phase {
                    ToolbarItem(placement: .primaryAction) {
                        ShareLink(item: url) { Image(systemName: "square.and.arrow.up") }
                            .accessibilityLabel("Share or save this file")
                    }
                }
            }
        }
        .task { await load() }
    }

    @ViewBuilder
    private func content(_ file: FetchedFile, _ url: URL) -> some View {
        let mime = file.mime.split(separator: ";").first.map {
            $0.trimmingCharacters(in: .whitespaces).lowercased()
        } ?? ""
        if mime == "text/markdown", let text = String(data: file.data, encoding: .utf8) {
            ScrollView {
                MarkdownText(source: text)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
            }
        } else if mime.hasPrefix("text/") || mime == "application/json",
                  let text = String(data: file.data, encoding: .utf8) {
            ScrollView([.vertical, .horizontal]) {
                Text(text)
                    .font(.system(size: 13, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
            }
        } else {
            QuickLookPreview(url: url)
                .ignoresSafeArea(edges: .bottom)
        }
    }

    private func load() async {
        do {
            let file = try await session.fetchFile(path: path)
            // QuickLook and the share sheet both want a file URL, and the
            // name matters: it is what Save to Files offers.
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent("viewed-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let name = file.name.isEmpty ? title : file.name
            let url = directory.appendingPathComponent(name)
            try file.data.write(to: url, options: .atomic)
            phase = .loaded(file, url)
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }
}

struct QuickLookPreview: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: QLPreviewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
            url as NSURL
        }
    }
}
