import SomnioTheme
import SwiftUI

/// Draft-backed inspector text field: the committed `value` seeds a local string draft that
/// parses back through `onCommit`. See `inspectorDraftLifecycle` for the reseed/commit rules.
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
                .inspectorDraftLifecycle(value: value, draft: $draft, isFocused: $isFocused, commit: commit)
                .fantasyFieldChrome()
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

/// Multi-line variant for the NPC dialog script, with the same draft lifecycle minus the parse
/// step. Return submits like any text field rather than inserting a newline.
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
                .inspectorDraftLifecycle(value: value, draft: $draft, isFocused: $isFocused, commit: commit)
                .fantasyFieldChrome()
            Text(L.resource("Script syntax: --- separates dialog steps; $name substitutes the player's nickname at runtime."))
                .font(.caption)
                .foregroundStyle(FantasyPalette.secondaryText)
        }
    }

    private func commit() {
        if draft != value {
            onCommit(draft)
        }
    }
}

/// The draft lifecycle every inspector field shares. The field commits through `commit` once on
/// Return or focus loss, never per keystroke, so each committed edit is exactly one undo step and
/// one scene reconcile.
extension View {
    func inspectorDraftLifecycle(
        value: some LosslessStringConvertible & Equatable,
        draft: Binding<String>,
        isFocused: FocusState<Bool>.Binding,
        commit: @escaping () -> Void
    ) -> some View {
        focused(isFocused)
            .onSubmit(commit)
            .onChange(of: value) { old, new in
                if let seeded = InspectorDraft.reseeded(
                    draft: draft.wrappedValue, isFocused: isFocused.wrappedValue, from: old, to: new
                ) {
                    draft.wrappedValue = seeded
                }
            }
            .onChange(of: isFocused.wrappedValue) { _, focused in
                if !focused {
                    commit()
                }
            }
    }
}

enum InspectorDraft {
    /// The draft's replacement text after the committed value changed from `old` to `new`, or
    /// `nil` to leave the draft alone. The comparison is against `old`, the value the draft was
    /// last seeded from, because that is what tells a draft the user typed into apart from one
    /// that merely hasn't caught up. Reseed an untouched focused draft too eagerly and nothing
    /// breaks; reseed a typed-into one and the edit is lost mid-keystroke. Skip an untouched one
    /// and a post-Return undo leaves the reverted value on screen, then re-commits the stale
    /// draft on blur.
    static func reseeded<Value: LosslessStringConvertible>(
        draft: String, isFocused: Bool, from old: Value, to new: Value
    ) -> String? {
        guard !isFocused || draft == String(old) else { return nil }
        return String(new)
    }
}
