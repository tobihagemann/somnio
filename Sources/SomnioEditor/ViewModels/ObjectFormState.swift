import Foundation
import SomnioCore

/// In-flight Object-dialog state. The model picker and `Stepper`s bind through `@Bindable`
/// once the dialog opens; the OK handler in `ObjectDialogView` consumes the values to append
/// a new `Object` via `SectorDocument.mutate`. Coordinates and the footprint extent are
/// sector-pixel space; `modelID` is a registry-sourced semantic id.
@Observable public final class ObjectFormState {
    public var x: Int16 = 0
    public var y: Int16 = 0
    public var modelID: String = EditorDefaults.defaultObjectModelID
    public var sourceWidth: Int16 = SomnioConstants.tileSize
    public var sourceHeight: Int16 = SomnioConstants.tileSize
    public var priority: Int16 = 0

    public init() {}

    public func reset(at point: GridPoint) {
        x = point.x
        y = point.y
        modelID = EditorDefaults.defaultObjectModelID
        sourceWidth = SomnioConstants.tileSize
        sourceHeight = SomnioConstants.tileSize
        priority = 0
    }

    public func buildObject() -> Object {
        Object(
            x: x,
            y: y,
            modelID: modelID,
            sourceWidth: sourceWidth,
            sourceHeight: sourceHeight,
            priority: priority
        )
    }
}
