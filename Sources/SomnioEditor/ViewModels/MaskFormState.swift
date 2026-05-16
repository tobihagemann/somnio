import Foundation
import SomnioCore

/// In-flight collision-mask dialog state.
@Observable public final class MaskFormState {
    public var x: Int16 = 0
    public var y: Int16 = 0
    public var width: Int16 = SomnioConstants.tileSize
    public var height: Int16 = SomnioConstants.tileSize

    public init() {}

    public func reset(at point: GridPoint) {
        x = point.x
        y = point.y
        width = SomnioConstants.tileSize
        height = SomnioConstants.tileSize
    }

    public func buildMask() -> CollisionMask {
        CollisionMask(x: x, y: y, width: width, height: height)
    }
}
