// The typed-Return detector behind the composer's send key.
//
// Every case is a real edit the composer receives: the send key at the end
// of a draft, in the middle of one, on an empty field, and the edits that
// must not be mistaken for it.
import XCTest
@testable import CompanionCore

final class ComposerReturnTests: XCTestCase {
    func testReturnAtEndOfDraftIsStripped() {
        XCTAssertEqual(ComposerReturn.textWithoutTypedReturn(old: "hello", new: "hello\n"), "hello")
    }

    func testReturnInTheMiddleIsStripped() {
        XCTAssertEqual(ComposerReturn.textWithoutTypedReturn(old: "ab", new: "a\nb"), "ab")
    }

    func testReturnOnEmptyDraftYieldsEmpty() {
        XCTAssertEqual(ComposerReturn.textWithoutTypedReturn(old: "", new: "\n"), "")
    }

    func testReturnAfterExistingNewlineIsStripped() {
        // a draft that already holds a hardware shift-return newline
        XCTAssertEqual(ComposerReturn.textWithoutTypedReturn(old: "a\nb", new: "a\nb\n"), "a\nb")
    }

    func testTypingAnyOtherCharacterIsNotAReturn() {
        XCTAssertNil(ComposerReturn.textWithoutTypedReturn(old: "hell", new: "hello"))
    }

    func testDeletionIsNotAReturn() {
        XCTAssertNil(ComposerReturn.textWithoutTypedReturn(old: "hello\n", new: "hello"))
    }

    func testMultiLinePasteIsNotAReturn() {
        XCTAssertNil(ComposerReturn.textWithoutTypedReturn(old: "", new: "one\ntwo"))
        XCTAssertNil(ComposerReturn.textWithoutTypedReturn(old: "x", new: "x\n\n"))
    }

    func testReplacementOfSameLengthPlusOneIsNotAReturn() {
        // "ab" -> "c\nd": one longer, contains a newline, but not an insertion
        XCTAssertNil(ComposerReturn.textWithoutTypedReturn(old: "ab", new: "c\nd"))
    }

    func testEmojiAndCombiningCharactersCountAsSingleCharacters() {
        XCTAssertEqual(ComposerReturn.textWithoutTypedReturn(old: "👍🏽é", new: "👍🏽é\n"), "👍🏽é")
    }
}
