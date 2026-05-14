import SwiftUI

/// Multi-line chat-input field. Return submits the message via `onSubmit`; the field
/// expands vertically as text is typed. The view exposes only the bound text and the
/// submit callback — the calling App owns the focus-state side effects that decide
/// what "paused" means while the field has focus.
public struct ChatInputView: View {
    @Binding public var text: String
    public let onSubmit: () -> Void

    public init(text: Binding<String>, onSubmit: @escaping () -> Void) {
        self._text = text
        self.onSubmit = onSubmit
    }

    public var body: some View {
        TextField("", text: $text, axis: .vertical)
            .textFieldStyle(.plain)
            .frame(width: 150, height: 85, alignment: .topLeading)
            .border(Color.black, width: 1)
            .onSubmit(onSubmit)
    }
}
