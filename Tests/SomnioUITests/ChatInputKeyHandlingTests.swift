import AppKit
import Testing
@testable import SomnioUI

/// Return-vs-Shift-Return routing in the chat field's text view.
///
/// Worth pinning because the two are indistinguishable one layer down: AppKit's
/// `StandardKeyBinding.dict` maps Return, keypad Enter, *and* Shift-Return to `insertNewline:`
/// (only Option-Return gets `insertNewlineIgnoringFieldEditor:`), so a `doCommand(by:)`-only
/// implementation cannot tell a submit from a modified Return. Driven through `keyDown(with:)`
/// — the same entry point a real keystroke takes — rather than by calling the overrides directly,
/// so the binding lookup is exercised too.
@MainActor
struct ChatInputKeyHandlingTests {
    /// A text view wired the way `ChatInputView.makeNSView` wires it, minus the chrome that only
    /// matters on screen.
    private static func textView() -> ReturnSubmittingTextView {
        let view = ReturnSubmittingTextView(frame: NSRect(x: 0, y: 0, width: 200, height: 52))
        view.isRichText = false
        return view
    }

    private static func keyEvent(
        characters: String,
        unmodified: String,
        modifiers: NSEvent.ModifierFlags,
        keyCode: UInt16
    ) throws -> NSEvent {
        try #require(NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: modifiers,
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: characters,
            charactersIgnoringModifiers: unmodified,
            isARepeat: false,
            keyCode: keyCode
        ))
    }

    /// keyCode 36 is Return. `characters` carries the carriage return with or without Shift, which
    /// is exactly why the modifier flag rather than the character has to decide.
    private static func returnKey(shift: Bool) throws -> NSEvent {
        try keyEvent(characters: "\r", unmodified: "\r", modifiers: shift ? .shift : [], keyCode: 36)
    }

    @Test func `return submits and leaves the text for the caller to clear`() throws {
        let view = Self.textView()
        var submissions = 0
        view.onSubmit = { submissions += 1 }
        view.string = "hallo"

        try view.keyDown(with: Self.returnKey(shift: false))

        #expect(submissions == 1)
        // The submit path never inserts: `ClientViewModel.submitChat` owns clearing the field.
        #expect(view.string == "hallo")
    }

    /// Neither submitting nor inserting: a newline survives to no renderer. `SpeechBubbleText.wrap`
    /// tokenizes on spaces, so it rides inside one unbreakable word and both the measurement and the
    /// `lines.count`-derived bubble height are wrong; the browser's canvas text drops it entirely
    /// where SwiftUI's honours it, so the two clients disagree about the same message.
    @Test func `shift return is swallowed rather than submitting or inserting`() throws {
        let view = Self.textView()
        var submissions = 0
        view.onSubmit = { submissions += 1 }
        view.string = "erste"
        view.setSelectedRange(NSRange(location: view.string.utf16.count, length: 0))

        try view.keyDown(with: Self.returnKey(shift: true))

        #expect(submissions == 0)
        #expect(view.string == "erste")
    }

    @Test func `an empty field still submits so the keyboard is handed back`() throws {
        let view = Self.textView()
        var submissions = 0
        view.onSubmit = { submissions += 1 }

        try view.keyDown(with: Self.returnKey(shift: false))

        // `submitChat` discards blank text on its own; what matters here is that Return always
        // reaches the submit path, because that is where the field resigns first responder.
        #expect(submissions == 1)
    }

    @Test func `a shifted ordinary character is neither submitted nor swallowed`() throws {
        let view = Self.textView()
        var submissions = 0
        view.onSubmit = { submissions += 1 }
        let event = try Self.keyEvent(characters: "A", unmodified: "a", modifiers: .shift, keyCode: 0)

        view.keyDown(with: event)

        // Shift is held here too, so a modifier-only guard would eat every capital letter.
        #expect(submissions == 0)
        #expect(view.string == "A")
    }
}
