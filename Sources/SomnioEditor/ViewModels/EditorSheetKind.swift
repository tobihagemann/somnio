import Foundation

/// Top-level identifier for the currently presented editor modal. Mirrors `SheetKind`
/// in the player client so `.sheet(item:)` can dispatch by case.
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
