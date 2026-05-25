import AppKit
import CoreGraphics
import Foundation

/// Pure-Foundation truncation + greedy word-wrap helpers for the speech bubble. The
/// font-driven measurement lives behind `defaultWidth(of:)` so unit tests can drive the
/// algorithm with a synthetic measurement closure.
public enum SpeechBubbleText {
    /// 150 px bubble width, matching the legacy `Sprechblase` template width.
    public static let bubbleWidth: CGFloat = 150

    /// Font size the wrap measurement and the renderer must share so pre-wrapped lines fit the
    /// width they were measured against.
    public static let fontSize: CGFloat = 10

    /// Greedy word-wraps `text` to fit `bubbleWidth` at System-10 metrics, then caps
    /// the result with `cap`. The wrap respects existing whitespace token boundaries
    /// only — long unbreakable words exceeding `bubbleWidth` are emitted as single
    /// lines (the renderer truncates them at draw time).
    @MainActor
    public static func wrap(
        _ text: String,
        maxLines: Int = 4,
        truncationGlyph: String = "..."
    ) -> [String] {
        wrap(text, maxLines: maxLines, truncationGlyph: truncationGlyph, widthOf: defaultWidth(of:))
    }

    /// Returns at most `maxLines` lines from `lines`. When the input is truncated, the
    /// last surviving line is appended with `truncationGlyph` to signal continuation.
    public static func cap(
        lines: [String],
        maxLines: Int = 4,
        truncationGlyph: String = "..."
    ) -> [String] {
        guard maxLines > 0 else { return [] }
        guard lines.count > maxLines else { return lines }
        var capped = Array(lines.prefix(maxLines))
        capped[capped.count - 1] += truncationGlyph
        return capped
    }

    /// Test seam — applies the greedy wrap algorithm using `widthOf` as the per-line
    /// width oracle, so unit tests can assert behavior without depending on AppKit
    /// font metrics.
    static func wrap(
        _ text: String,
        maxLines: Int,
        truncationGlyph: String,
        widthOf: (String) -> CGFloat
    ) -> [String] {
        let words = text.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
        guard !words.isEmpty else { return [] }
        var lines: [String] = []
        var current = ""
        for word in words {
            let candidate = current.isEmpty ? word : current + " " + word
            if widthOf(candidate) <= bubbleWidth {
                current = candidate
            } else {
                if !current.isEmpty {
                    lines.append(current)
                }
                current = word
            }
        }
        if !current.isEmpty {
            lines.append(current)
        }
        return cap(lines: lines, maxLines: maxLines, truncationGlyph: truncationGlyph)
    }

    @MainActor
    private static func defaultWidth(of text: String) -> CGFloat {
        let font = NSFont.systemFont(ofSize: fontSize)
        return (text as NSString).size(withAttributes: [.font: font]).width
    }
}
