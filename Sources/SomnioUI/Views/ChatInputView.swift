import SwiftUI

/// Multi-line chat-input field. Return submits via `onSubmit`; the field expands
/// vertically as text is typed. Focus is owned by the parent (`MainWindowView`) and
/// threaded in as a `FocusState.Binding` so a tap on the play field can force-blur
/// the chat — `SpriteView`'s underlying `SKView` returns `false` for
/// `acceptsFirstResponder`, so the macOS-standard "click outside the field to blur"
/// path does not work without explicit handling.
public struct ChatInputView: View {
    @Binding public var text: String
    public let onSubmit: () -> Void
    @FocusState.Binding public var isFocused: Bool

    public init(
        text: Binding<String>,
        onSubmit: @escaping () -> Void,
        isFocused: FocusState<Bool>.Binding
    ) {
        self._text = text
        self.onSubmit = onSubmit
        self._isFocused = isFocused
    }

    public var body: some View {
        TextField("", text: $text, axis: .vertical)
            .textFieldStyle(.plain)
            // Inset the text 4px inside the border to match `ChatScrollbackView`'s content padding,
            // so the input row and the history above it share the same left/top text margin.
            .padding(4)
            .frame(width: 150, height: 85, alignment: .topLeading)
            .border(Color.black, width: 1)
            .focused($isFocused)
            // The TextField's single-line intrinsic hit area covers only the top row, but the
            // bordered box looks 85 px tall. Make the whole footprint focusable so a tap on the
            // lower rows focuses the field (same idiom as `ItemsListView`'s hand cells).
            .contentShape(Rectangle())
            .onTapGesture { isFocused = true }
            .onSubmit {
                onSubmit()
                isFocused = false
            }
            .onKeyPress(.escape) {
                isFocused = false
                return .handled
            }
    }
}
