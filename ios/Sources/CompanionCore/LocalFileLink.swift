// Links in a reply that point at a file on the Mac.
//
// Bots hand over documents they wrote as `[report.md](/Users/…/report.md)`
// or as a `file://` URL. The desktop recognises both and offers to save a
// copy; SwiftUI hands them to `UIApplication.open`, which refuses a URL with
// no scheme and has nothing behind a `file://` one, so the tap did nothing.
// This is the desktop's `localFilePath` check, so the two clients agree on
// which links are files and which are the web.
import Foundation

public enum LocalFileLink {
    /// The path to ask the server for, or nil when the link is an ordinary
    /// web link the system should open.
    public static func path(for url: URL) -> String? {
        let scheme = url.scheme?.lowercased() ?? ""
        switch scheme {
        case "":
            // "/Users/…" parses with no scheme; `path` percent-decodes.
            let path = url.path
            return path.hasPrefix("/") ? path : nil
        case "file":
            // Handed over whole: the server's URL parser also knows about
            // the "/C:/…" shape a Windows file URL takes.
            return url.absoluteString
        default:
            // "C:\…" parses as scheme "c". A one-letter scheme is a drive.
            if scheme.count == 1, scheme.first!.isLetter { return url.absoluteString }
            return nil
        }
    }
}
