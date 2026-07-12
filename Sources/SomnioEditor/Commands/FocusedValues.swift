import SwiftUI

/// `FocusedValue` carrier for the currently-active editor window. `SectorWindowView`
/// injects the `(document, workspace, undoManager)` triple via `.focusedSceneValue(...)`
/// so the top-level `.commands { ... }` builder can route Grid, Save, Import, Export,
/// and Duplicate actions to the focused document — including undo-registered mutations,
/// which a command builder cannot reach through `@Environment(\.undoManager)`.
@MainActor public struct EditorWorkspaceFocusValue: Equatable {
    public let document: SectorDocument
    public let workspace: SectorWorkspace
    public let undoManager: UndoManager?

    public nonisolated static func == (lhs: EditorWorkspaceFocusValue, rhs: EditorWorkspaceFocusValue) -> Bool {
        lhs.document === rhs.document && lhs.workspace === rhs.workspace
    }
}

public struct EditorWorkspaceKey: FocusedValueKey {
    public typealias Value = EditorWorkspaceFocusValue
}

public extension FocusedValues {
    var editorWorkspace: EditorWorkspaceFocusValue? {
        get { self[EditorWorkspaceKey.self] }
        set { self[EditorWorkspaceKey.self] = newValue }
    }
}
