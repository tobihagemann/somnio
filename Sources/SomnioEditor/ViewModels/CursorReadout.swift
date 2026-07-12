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
    /// selection changes; W/H track a single selection only (a multi-selection has no one
    /// record size) and clear when nothing is selected so the readout doesn't stay pinned
    /// to a deleted record's old dimensions.
    public func applyBounds(for selection: Set<EditorSelection>, in body: SectorBody) {
        guard selection.count == 1, let size = selection.first?.bounds(in: body)?.size else {
            width = 0
            height = 0
            return
        }
        width = size.width
        height = size.height
    }
}
