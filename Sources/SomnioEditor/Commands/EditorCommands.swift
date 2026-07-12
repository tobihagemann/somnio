import SomnioCore
import SwiftUI

/// Selection commands after the standard pasteboard group: Duplicate Selection (⌘D —
/// copy + paste-offset in one undo step, no pasteboard round-trip) and the Grid ⌘G
/// toggle. Copy/Paste themselves ride the standard Edit menu through the canvas's
/// `onCopyCommand`/`onPasteCommand`, so text fields keep their own text clipboard.
public struct EditorCommands: Commands {
    @FocusedValue(\.editorWorkspace) private var focused

    public init() {}

    public var body: some Commands {
        CommandGroup(after: .pasteboard) {
            Button {
                duplicateSelection()
            } label: {
                Text(L.resource("Duplicate Selection"))
            }
            .keyboardShortcut("d", modifiers: [.command])
            .disabled(focused?.workspace.selection.isEmpty ?? true)

            Button {
                focused?.workspace.showGridOverlay.toggle()
            } label: {
                Text(L.resource("Grid"))
            }
            .keyboardShortcut("g", modifiers: [.command])
            .disabled(focused == nil)
        }
    }

    private func duplicateSelection() {
        guard let focused else { return }
        let clipboard = EditorClipboard.capture(focused.workspace.selection, from: focused.document.body)
        guard !clipboard.isEmpty else { return }
        var inserted: Set<EditorSelection> = []
        focused.document.mutate("Duplicate Selection", undoManager: focused.undoManager) { body in
            inserted = clipboard.inserting(
                into: &body,
                anchor: nil,
                fallbackOffset: max(1, EditorDefaults.currentGridStepPx())
            )
        }
        focused.workspace.selection = inserted
    }
}
