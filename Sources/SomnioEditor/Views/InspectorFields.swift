import SomnioTheme
import SwiftUI

/// Draft-backed inspector text field: the committed `value` seeds a local string draft, and
/// the draft writes back through `onCommit` **once** on Return or focus loss — never per
/// keystroke, so each committed edit is exactly one undo step and one scene reconcile.
///
/// Draft lifecycle: when the committed value changes externally (drag-move, keyboard nudge,
/// undo/redo, a sibling control) the draft reseeds unless the user is mid-edit — an
/// untouched focused draft still follows the document, so a post-Return undo shows the
/// reverted value instead of re-committing the stale draft on blur. The hosting view pins
/// identity per selection (`.id(selection)`), so switching records rebuilds the drafts.
@MainActor struct InspectorDraftField<Value: LosslessStringConvertible & Equatable>: View {
    let title: LocalizedStringResource
    let value: Value
    let onCommit: (Value) -> Void

    @State private var draft: String
    @FocusState private var isFocused: Bool

    init(_ title: LocalizedStringResource, value: Value, onCommit: @escaping (Value) -> Void) {
        self.title = title
        self.value = value
        self.onCommit = onCommit
        self._draft = State(initialValue: String(value))
    }

    var body: some View {
        HStack {
            Text(title)
                .frame(width: 96, alignment: .leading)
            TextField("", text: $draft)
                .focused($isFocused)
                .onSubmit(commit)
                .fantasyFieldChrome()
        }
        .onChange(of: value) { old, new in
            if !isFocused || draft == String(old) {
                draft = String(new)
            }
        }
        .onChange(of: isFocused) { _, focused in
            if !focused {
                commit()
            }
        }
    }

    private func commit() {
        guard let parsed = Value(draft) else {
            draft = String(value)
            return
        }
        if parsed != value {
            onCommit(parsed)
        }
        draft = String(parsed)
    }
}

/// Multi-line variant for the NPC dialog script. Same draft lifecycle as
/// `InspectorDraftField`; commits on focus loss (Return submits like any text field —
/// insert literal step separators with `---` lines).
@MainActor struct InspectorScriptField: View {
    let value: String
    let onCommit: (String) -> Void

    @State private var draft: String
    @FocusState private var isFocused: Bool

    init(value: String, onCommit: @escaping (String) -> Void) {
        self.value = value
        self.onCommit = onCommit
        self._draft = State(initialValue: value)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(L.resource("Script"))
            TextField("", text: $draft, axis: .vertical)
                .lineLimit(3 ... 10)
                .focused($isFocused)
                .onSubmit(commit)
                .fantasyFieldChrome()
            Text(L.resource("Script syntax: --- separates dialog steps; $name substitutes the player's nickname at runtime."))
                .font(.caption)
                .foregroundStyle(FantasyPalette.secondaryText)
        }
        .onChange(of: value) { old, new in
            if !isFocused || draft == old {
                draft = new
            }
        }
        .onChange(of: isFocused) { _, focused in
            if !focused {
                commit()
            }
        }
    }

    private func commit() {
        if draft != value {
            onCommit(draft)
        }
    }
}
