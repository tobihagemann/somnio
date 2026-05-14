import Testing
@testable import SomnioUI

struct SpeechBubbleTextTests {
    @Test func `five lines truncate to four with trailing ellipsis`() {
        let result = SpeechBubbleText.cap(lines: ["one", "two", "three", "four", "five"])
        #expect(result == ["one", "two", "three", "four..."])
    }

    @Test func `three lines pass through unchanged`() {
        let result = SpeechBubbleText.cap(lines: ["one", "two", "three"])
        #expect(result == ["one", "two", "three"])
    }

    @Test func `exact four-line input passes through unchanged`() {
        let result = SpeechBubbleText.cap(lines: ["one", "two", "three", "four"])
        #expect(result == ["one", "two", "three", "four"])
    }

    @Test func `max lines one truncates a two-line input`() {
        let result = SpeechBubbleText.cap(lines: ["one", "two"], maxLines: 1)
        #expect(result == ["one..."])
    }

    @Test func `empty input returns empty output`() {
        let result = SpeechBubbleText.cap(lines: [])
        #expect(result.isEmpty)
    }

    @Test func `zero max lines returns empty output`() {
        let result = SpeechBubbleText.cap(lines: ["one"], maxLines: 0)
        #expect(result.isEmpty)
    }
}
