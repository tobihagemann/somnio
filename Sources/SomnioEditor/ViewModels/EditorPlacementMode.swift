import Foundation

/// Discriminates the four authoring modes the editor exposes per R37. Drives the per-tool
/// dialog dispatch in `SectorWindowView` and the palette layout under `SectorWorkspace`.
public enum EditorPlacementMode: String, Identifiable, CaseIterable, Sendable {
    case object
    case mask
    case portal
    case spawn

    public var id: Self {
        self
    }
}
