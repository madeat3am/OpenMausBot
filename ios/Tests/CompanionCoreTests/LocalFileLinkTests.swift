// Which tapped links are files on the Mac and which are the web.
import XCTest
@testable import CompanionCore

final class LocalFileLinkTests: XCTestCase {
    private func url(_ string: String) -> URL { URL(string: string)! }

    func testAbsolutePathIsAFile() {
        XCTAssertEqual(LocalFileLink.path(for: url("/Users/omkar/.openmausbot/report.md")),
                       "/Users/omkar/.openmausbot/report.md")
    }

    func testPercentEncodedPathIsDecoded() {
        XCTAssertEqual(LocalFileLink.path(for: url("/Users/omkar/My%20Report.md")),
                       "/Users/omkar/My Report.md")
    }

    func testFileURLIsHandedOverWhole() {
        XCTAssertEqual(LocalFileLink.path(for: url("file:///Users/omkar/report.md")),
                       "file:///Users/omkar/report.md")
        XCTAssertEqual(LocalFileLink.path(for: url("FILE:///Users/omkar/report.md")),
                       "FILE:///Users/omkar/report.md")
    }

    func testWindowsDriveIsAFile() {
        XCTAssertEqual(LocalFileLink.path(for: url("C:/Users/omkar/report.md")), "C:/Users/omkar/report.md")
    }

    func testWebLinksAreNotFiles() {
        XCTAssertNil(LocalFileLink.path(for: url("https://example.com/report.md")))
        XCTAssertNil(LocalFileLink.path(for: url("http://example.com")))
        XCTAssertNil(LocalFileLink.path(for: url("mailto:someone@example.com")))
    }

    func testRelativePathIsNotAFile() {
        XCTAssertNil(LocalFileLink.path(for: url("docs/report.md")))
        XCTAssertNil(LocalFileLink.path(for: url("report.md")))
    }
}
