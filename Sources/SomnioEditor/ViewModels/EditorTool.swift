import Foundation

/// Active canvas tool. `select` drives the direct-manipulation layer (click-select,
/// drag-move, handle-resize, marquee); each placement tool makes a canvas press place
/// that concrete record kind — NPCs and monsters are distinct tools so a click is never
/// ambiguous between the two `SectorBody` arrays.
public enum EditorTool: String, Identifiable, CaseIterable, Sendable {
    case select
    case object
    case mask
    case portal
    case npc
    case monster

    public var id: Self {
        self
    }
}
