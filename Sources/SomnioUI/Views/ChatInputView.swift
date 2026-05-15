import SwiftUI

/// Multi-line chat-input field. Return submits the message via `onSubmit`; the field
/// expands vertically as text is typed. The view exposes the bound text, the submit
/// callback, and an optional `onFocusChange` callback that fires whenever the field
/// gains or loses focus — the calling App owns the side effects that decide what
/// "paused" means while the field has focus.
public struct ChatInputView: View {
    @Binding public var text: String
    public let onSubmit: () -> Void
    public let onFocusChange: ((Bool) -> Void)?
    @FocusState private var isFocused: Bool

    public init(
        text: Binding<String>,
        onSubmit: @escaping () -> Void,
        onFocusChange: ((Bool) -> Void)? = nil
    ) {
        self._text = text
        self.onSubmit = onSubmit
        self.onFocusChange = onFocusChange
    }

    public var body: some View {
        TextField("", text: $text, axis: .vertical)
            .textFieldStyle(.plain)
            .frame(width: 150, height: 85, alignment: .topLeading)
            .border(Color.black, width: 1)
            .focused($isFocused)
            .onSubmit(onSubmit)
            .onChange(of: isFocused) { _, newValue in
                onFocusChange?(newValue)
            }
    }
}
