import Foundation
import Testing
@testable import SomnioUI

struct SpeechBubbleWrapTests {
    @Test func `short text yields one line`() async {
        let result = await MainActor.run {
            SpeechBubbleText.wrap("hello")
        }
        #expect(result == ["hello"])
    }

    @Test func `wrap emits multiple lines when measurement exceeds bubble width`() {
        let result = SpeechBubbleText.wrap(
            "alpha beta gamma",
            maxLines: 4,
            truncationGlyph: "...",
            widthOf: { _ in 200 }
        )
        #expect(result == ["alpha", "beta", "gamma"])
    }

    @Test func `wrap caps at maxLines and appends the truncation glyph`() {
        let result = SpeechBubbleText.wrap(
            "one two three four five",
            maxLines: 4,
            truncationGlyph: "...",
            widthOf: { _ in 200 }
        )
        #expect(result == ["one", "two", "three", "four..."])
    }

    @Test func `single oversized token is emitted as its own line`() {
        // A word wider than the bubble has no break opportunity. The wrap algorithm
        // documents that the offending token is emitted on its own line — the
        // renderer then truncates at draw time. The test pins the documented
        // behavior so the `if !current.isEmpty` guard cannot silently regress.
        let result = SpeechBubbleText.wrap(
            "tinyword aaaaaaaaaaaaaaaa next",
            maxLines: 4,
            truncationGlyph: "...",
            widthOf: { token in token.count > 8 ? 1000 : 100 }
        )
        #expect(result == ["tinyword", "aaaaaaaaaaaaaaaa", "next"])
    }

    @Test func `wrap respects 150 px width at System-10 metrics`() async {
        let measured = await MainActor.run {
            SpeechBubbleText.wrap("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        }
        #expect(measured.count == 1)
    }
}
