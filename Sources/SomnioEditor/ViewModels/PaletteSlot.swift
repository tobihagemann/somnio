import Foundation

/// Active palette button in the 2×4 placement grid mirroring the legacy `ToolButton(0..7)`
/// layout. The left column drives canvas-tap behavior to "select an existing record"
/// (`.selectAndEdit`) while the right column drives "open the per-tool dialog for placing
/// a new record" (`.placeNew`). Both branches are keyed off the same `EditorPlacementMode`
/// so toggling left↔right keeps the active record type stable.
public enum PaletteSlot: Sendable, Equatable, Hashable {
    case selectAndEdit(EditorPlacementMode)
    case placeNew(EditorPlacementMode)

    public var mode: EditorPlacementMode {
        switch self {
        case let .selectAndEdit(mode): return mode
        case let .placeNew(mode): return mode
        }
    }
}
