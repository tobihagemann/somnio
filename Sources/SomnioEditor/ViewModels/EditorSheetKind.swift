import Foundation

/// Top-level identifier for the currently presented editor modal, dispatched by case
/// through `.sheet(item:)` (the editor keeps native sheets; the player client's
/// counterpart is `OverlayKind`).
public enum EditorSheetKind: Identifiable, Sendable, Equatable {
    case newMap
    case objectDialog
    case maskDialog
    case portalDialog
    case spawnDialog
    case about

    public var id: Self {
        self
    }
}
