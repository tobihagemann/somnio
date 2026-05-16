import Foundation

/// Per-document `SectorWorkspace` lookup keyed by `SectorDocument.id`. The registry
/// exists because `ReferenceFileDocument`'s file-API methods must be nonisolated and
/// therefore cannot read main-actor state directly — the document holds only the
/// serializable model and looks up its UI workspace through this registry.
@MainActor public enum SectorWorkspaceRegistry {
    private static var workspaces: [UUID: SectorWorkspace] = [:]

    /// Idempotent: first call for a given documentID creates and stores the workspace;
    /// every subsequent call returns the same instance. The dictionary lookup is the
    /// only branch in the function body — SwiftUI re-evaluates `body` arbitrarily, so
    /// preserving workspace identity across redraws is load-bearing for WorldScene
    /// continuity and in-flight presentedSheet state.
    public static func workspace(forID id: UUID) -> SectorWorkspace {
        if let existing = workspaces[id] { return existing }
        let fresh = SectorWorkspace()
        workspaces[id] = fresh
        return fresh
    }

    public static func discard(documentID id: UUID) {
        workspaces.removeValue(forKey: id)
    }

    #if DEBUG
        public static var count: Int {
            workspaces.count
        }
    #endif
}
