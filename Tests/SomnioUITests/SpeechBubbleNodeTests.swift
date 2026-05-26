import CoreGraphics
import Testing
@testable import SomnioUI

@MainActor
struct SpeechBubbleNodeTests {
    @Test(arguments: [
        (lineCount: 1, expected: CGRect(x: 0, y: 0, width: 150, height: 32)),
        (lineCount: 2, expected: CGRect(x: 0, y: 32, width: 150, height: 44)),
        (lineCount: 3, expected: CGRect(x: 0, y: 76, width: 150, height: 56)),
        (lineCount: 4, expected: CGRect(x: 0, y: 132, width: 150, height: 68))
    ])
    func `balloonFrameRect picks the legacy band for each line count`(lineCount: Int, expected: CGRect) {
        #expect(SpeechBubbleNode.balloonFrameRect(lineCount: lineCount) == expected)
    }

    @Test func `balloonFrameRect clamps an out-of-range line count into the four bands`() {
        // Capped line counts are always 1...4; the clamp guards a stray 0 or 5 against trapping.
        #expect(SpeechBubbleNode.balloonFrameRect(lineCount: 0) == CGRect(x: 0, y: 0, width: 150, height: 32))
        #expect(SpeechBubbleNode.balloonFrameRect(lineCount: 5) == CGRect(x: 0, y: 132, width: 150, height: 68))
    }
}
