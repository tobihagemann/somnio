import Foundation

/// Pure-Foundation truncation helper for the speech bubble's line cap. The wrapping
/// step that produces `lines` lives on `SpeechBubbleNode` (font-driven, `@MainActor`);
/// this helper is the synchronous seam exercised by unit tests.
public enum SpeechBubbleText {
    /// Returns at most `maxLines` lines from `lines`. When the input is truncated, the
    /// last surviving line is appended with ASCII `"..."` to signal continuation.
    public static func cap(lines: [String], maxLines: Int = 4) -> [String] {
        guard maxLines > 0 else { return [] }
        guard lines.count > maxLines else { return lines }
        var capped = Array(lines.prefix(maxLines))
        capped[capped.count - 1] += "..."
        return capped
    }
}
