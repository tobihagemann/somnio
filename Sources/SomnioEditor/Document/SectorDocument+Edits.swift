import Combine
import Foundation
import SomnioCore
import SwiftUI

@MainActor
public extension SectorDocument {
    /// Single mutation API. Captures the pre-image, applies the change, refreshes the
    /// per-document workspace (3D scene + overlay + selection clamp), and
    /// registers an `UndoManager` callback that re-enters `mutate(...)` to restore the
    /// snapshot. The inner re-entry captures the *current* `body` as its own pre-image,
    /// so undo records redo automatically — symmetric across N steps.
    func mutate(
        _ description: String.LocalizationValue,
        undoManager: UndoManager?,
        _ change: (inout SectorBody) -> Void
    ) {
        let before = body
        applyMutation(change)
        undoManager?.setActionName(L.string(description))
        undoManager?.registerUndo(withTarget: self) { target in
            // UndoManager's closure runs without main-actor isolation; bridge with
            // `assumeIsolated` so the re-entrant call to the @MainActor `mutate(...)`
            // type-checks under Swift 6 strict concurrency. NSUndoManager invokes
            // undo on the main thread in practice, so the assertion never traps.
            MainActor.assumeIsolated {
                target.mutate(description, undoManager: undoManager) { $0 = before }
            }
        }
        let workspace = SectorWorkspaceRegistry.workspace(forID: id)
        workspace.reconcile(with: body, sectorName: sectorName)
    }

    /// Sector-name rename routed through the same dirty-tracking machinery so the
    /// macOS standard "save changes" prompt fires after a rename-only edit. Reconciles
    /// the workspace so any UI surface that surfaces the sector name (overlay labels,
    /// future title bars) reflects the new value immediately.
    func renameSector(to newName: String, undoManager: UndoManager?) {
        let before = sectorName
        applySectorName(newName)
        undoManager?.setActionName(L.string("Rename sector"))
        undoManager?.registerUndo(withTarget: self) { target in
            MainActor.assumeIsolated {
                target.renameSector(to: before, undoManager: undoManager)
            }
        }
        let workspace = SectorWorkspaceRegistry.workspace(forID: id)
        workspace.reconcile(with: body, sectorName: sectorName)
    }
}
