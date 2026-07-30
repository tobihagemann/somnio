import AppKit
import SwiftUI

/// Multi-line chat-input field backed by an `NSTextView` rather than a SwiftUI
/// `TextField(axis:)`. SwiftUI's multi-line field spawns an empty automatic-text-completion
/// popover at launch (a stray translucent popover-level window) and exposes no hook to
/// suppress it; an owned `NSTextView` with completion disabled does not. Return submits via
/// `onSubmit`; Escape is owned by the app-level monitor, which blurs by driving `isFocused`
/// to `false`. Focus is a plain `Bool` binding synced to the text view's first-responder
/// state, because the RealityKit play field never takes first responder — the parent blurs
/// the chat by driving `isFocused` to `false`. Sized and chromed by its host panel.
public struct ChatInputView: View {
    @Binding public var text: String
    public let onSubmit: () -> Void
    @Binding public var isFocused: Bool

    public init(
        text: Binding<String>,
        onSubmit: @escaping () -> Void,
        isFocused: Binding<Bool>
    ) {
        self._text = text
        self.onSubmit = onSubmit
        self._isFocused = isFocused
    }

    public var body: some View {
        ChatInputTextView(text: $text, isFocused: $isFocused, onSubmit: onSubmit)
    }
}

/// `NSTextView` host. Completion is off to suppress the launch popover; substitutions are off
/// so chat text is never silently rewritten.
private struct ChatInputTextView: NSViewRepresentable {
    @Binding var text: String
    @Binding var isFocused: Bool
    let onSubmit: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(text: $text, isFocused: $isFocused)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = false

        let textView = ReturnSubmittingTextView()
        textView.delegate = context.coordinator
        textView.onFocusChange = { [coordinator = context.coordinator] focused in
            coordinator.setFocused(focused)
        }
        textView.isRichText = false
        textView.isAutomaticTextCompletionEnabled = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.drawsBackground = false
        // 13pt matches `ChatScrollbackView`'s implicit SwiftUI body font so the input row and the
        // scrollback above it render at the same size; keep it in sync if that font changes.
        textView.font = .systemFont(ofSize: 13)
        // The host panel's plate is dark in either system appearance, so the adaptive label
        // color (black in light mode) would vanish; pin the text and caret to white.
        textView.textColor = .white
        textView.insertionPointColor = .white
        // Match `ChatScrollbackView`'s 4px content padding so the input row and the history
        // above it share the same left/top text margin. `lineFragmentPadding` (default 5) would
        // otherwise stack on top of `textContainerInset` and push the text further in.
        textView.textContainerInset = NSSize(width: 4, height: 4)
        textView.textContainer?.lineFragmentPadding = 0
        textView.minSize = NSSize(width: 0, height: 0)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.containerSize = NSSize(
            width: scrollView.contentSize.width,
            height: CGFloat.greatestFiniteMagnitude
        )

        scrollView.documentView = textView
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context _: Context) {
        guard let textView = scrollView.documentView as? ReturnSubmittingTextView else { return }
        textView.onSubmit = onSubmit
        // Keep the (empty) text view at least as tall as the visible area so a click anywhere
        // in the bordered box lands on the text view and focuses it, rather than hitting the
        // scroll view's bare background below a collapsed one-line document view.
        textView.minSize = NSSize(width: 0, height: scrollView.contentSize.height)
        if textView.string != text {
            textView.string = text
        }
        let isFirstResponder = textView.window?.firstResponder === textView
        if isFocused, !isFirstResponder {
            textView.window?.makeFirstResponder(textView)
        } else if !isFocused, isFirstResponder {
            // Resign here on unfocus — the play field can't take first responder to do it for us.
            textView.window?.makeFirstResponder(nil)
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        @Binding var text: String
        @Binding var isFocused: Bool

        init(text: Binding<String>, isFocused: Binding<Bool>) {
            _text = text
            _isFocused = isFocused
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            text = textView.string
        }

        /// Driven by the text view's first-responder transitions, which fire before the first
        /// keystroke — in time to release the gameplay-key monitor so the field can be typed
        /// into. `makeFirstResponder` in `updateNSView` can call this re-entrantly, so only
        /// write the binding on a real change to avoid tripping SwiftUI's "modifying state
        /// during update" guard.
        func setFocused(_ focused: Bool) {
            if isFocused != focused { isFocused = focused }
        }
    }
}

/// Submits on Return and swallows Shift-Return — see `keyDown` for why a line break has nowhere
/// to go. Escape is deliberately NOT handled here: the app-level Escape monitor owns that key
/// (chat blur, game menu) and consumes it before the responder chain would deliver
/// `cancelOperation` — a second owner here would be dead code. `mouseDown` marks the user's
/// intent to focus before the click is processed, so only a deliberate click registers as
/// focus — an auto/programmatic first-responder gain on launch does not.
///
/// Internal rather than private so the key handling is reachable from a test; nothing else
/// in the module refers to it.
final class ReturnSubmittingTextView: NSTextView {
    var onSubmit: (() -> Void)?
    var onFocusChange: ((Bool) -> Void)?

    /// The three characters AppKit's `StandardKeyBinding.dict` maps to `insertNewline:`:
    /// carriage return, keypad enter, and line feed.
    private static let newlineKeys: [NSEvent.SpecialKey] = [.carriageReturn, .enter, .newline]

    override func mouseDown(with event: NSEvent) {
        onFocusChange?(true)
        super.mouseDown(with: event)
    }

    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned { onFocusChange?(false) }
        return resigned
    }

    /// Shift-Return is swallowed: it neither submits nor inserts.
    ///
    /// A line break has nowhere to go. `SpeechBubbleText.wrap` tokenizes on spaces only, so a
    /// newline rides along inside one unbreakable "word" and both the measurement and the
    /// `lines.count`-derived bubble height are wrong; the server passes the text through on the
    /// byte cap alone; and the browser's canvas `fillText` drops `\n` entirely where SwiftUI `Text`
    /// honours it, so the two clients would disagree about the same message. Accepting the
    /// keystroke would promise a second line the game cannot draw.
    ///
    /// It has to be caught here rather than in `doCommand(by:)`: AppKit's standard bindings map
    /// Return, keypad Enter, and Shift-Return alike to `insertNewline:` — only Option-Return gets
    /// its own `insertNewlineIgnoringFieldEditor:` entry — so the selector cannot tell them apart.
    override func keyDown(with event: NSEvent) {
        if event.modifierFlags.contains(.shift), isNewlineKey(event) { return }
        super.keyDown(with: event)
    }

    override func doCommand(by selector: Selector) {
        switch selector {
        case #selector(insertNewline(_:)):
            onSubmit?()
            // Hand the keyboard back to the play field, which cannot take first responder
            // itself. Unconditional, so Return on an empty field also releases the gameplay
            // keys rather than leaving the character unable to walk.
            window?.makeFirstResponder(nil)
        default:
            super.doCommand(by: selector)
        }
    }

    private func isNewlineKey(_ event: NSEvent) -> Bool {
        guard let special = event.specialKey else { return false }
        return Self.newlineKeys.contains(special)
    }
}
