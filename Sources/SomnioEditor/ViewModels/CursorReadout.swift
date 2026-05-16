import Foundation
import SomnioCore

/// HUD strip values: X/Y track the cursor in sector-pixel coordinates (top-left origin)
/// and W/H mirror the bounds of the currently-selected record. Three of the four values
/// update from continuous-hover events; W/H comes from `.onChange(of: workspace.selection)`
/// because the `@Observable` macro discards user-provided `didSet`/`willSet` accessors.
@Observable public final class CursorReadout {
    public var x: Int16 = 0
    public var y: Int16 = 0
    public var width: Int16 = 0
    public var height: Int16 = 0

    public init() {}

    /// Pulls the selected record's bounds out of the sector body. Called whenever the
    /// selection changes; clears W/H when nothing is selected so the HUD doesn't stay
    /// pinned to a deleted record's old dimensions.
    public func applyBounds(for selection: EditorSelection?, in body: SectorBody) {
        let size = selection?.bounds(in: body)?.size ?? .zero
        width = size.width
        height = size.height
    }
}
