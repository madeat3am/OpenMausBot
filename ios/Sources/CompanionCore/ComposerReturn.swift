// The Return key on a multi-line composer.
//
// A `TextField` with `axis: .vertical` treats the software keyboard's Return
// as "insert a newline" and never calls `onSubmit`, even with
// `.submitLabel(.send)` painting the key as a blue send arrow. `onKeyPress`
// only sees hardware keyboards. So the phone showed a send key that added a
// line instead — the bug this exists to close.
//
// The only signal the view gets is the text changing. This recognises the
// one edit a tapped Return makes — a single "\n" inserted somewhere — so the
// view can strip it and send. Anything else (a paste of several lines, a
// dictation rebuild, a deletion) is left alone.
import Foundation

public enum ComposerReturn {
    /// The text with the typed newline removed, or nil when the change from
    /// `old` to `new` was not exactly one inserted "\n".
    public static func textWithoutTypedReturn(old: String, new: String) -> String? {
        let before = Array(old)
        let after = Array(new)
        guard after.count == before.count + 1 else { return nil }
        // Return inserts at the cursor, which is usually but not always the
        // end: find the first divergence, check it is the newline, and that
        // the remainder lines up.
        var index = 0
        while index < before.count, before[index] == after[index] { index += 1 }
        guard after[index] == "\n" else { return nil }
        guard Array(after[(index + 1)...]) == Array(before[index...]) else { return nil }
        var stripped = after
        stripped.remove(at: index)
        return String(stripped)
    }
}
