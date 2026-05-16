import Foundation
import SomnioCore

/// In-flight Object-dialog state. `Stepper`s bind through `@Bindable` once the dialog
/// opens; the OK handler in `ObjectDialogView` consumes the values to append a new
/// `Object` via `SectorDocument.mutate`. Coordinates are sector-pixel space; tileset
/// indices stay `Int16` to round-trip the wire format.
@Observable public final class ObjectFormState {
    public var x: Int16 = 0
    public var y: Int16 = 0
    public var tilesetIndex: Int16 = 0
    public var sourceX: Int16 = 0
    public var sourceY: Int16 = 0
    public var sourceWidth: Int16 = SomnioConstants.tileSize
    public var sourceHeight: Int16 = SomnioConstants.tileSize
    public var priority: Int16 = 0

    public init() {}

    public func reset(at point: GridPoint) {
        x = point.x
        y = point.y
        tilesetIndex = 0
        sourceX = 0
        sourceY = 0
        sourceWidth = SomnioConstants.tileSize
        sourceHeight = SomnioConstants.tileSize
        priority = 0
    }

    public func buildObject() -> Object {
        Object(
            x: x,
            y: y,
            tilesetIndex: tilesetIndex,
            sourceX: sourceX,
            sourceY: sourceY,
            sourceWidth: sourceWidth,
            sourceHeight: sourceHeight,
            priority: priority
        )
    }
}
