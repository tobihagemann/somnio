import SwiftUI

/// Grid ⌘G toggle. Bound to the focused window's `SectorWorkspace.showGridOverlay`;
/// `EditorOverlayLayer` re-renders the grid on the next reconcile cycle.
public struct EditorCommands: Commands {
    @FocusedValue(\.editorWorkspace) private var focused

    public init() {}

    public var body: some Commands {
        CommandGroup(after: .pasteboard) {
            Button {
                focused?.workspace.showGridOverlay.toggle()
            } label: {
                Text(L.resource("Grid"))
            }
            .keyboardShortcut("g", modifiers: [.command])
            .disabled(focused == nil)
        }
    }
}
