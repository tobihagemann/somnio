import Foundation
import SomnioCore

/// In-flight sector-portal dialog state. `direction` defaults to the outbound trigger
/// because the typical authoring flow is "drop a trigger first, then drop the arrival
/// placement in the target sector."
@Observable public final class PortalFormState {
    public var x: Int16 = 0
    public var y: Int16 = 0
    public var width: Int16 = SomnioConstants.tileSize
    public var height: Int16 = SomnioConstants.tileSize
    public var targetSectorName: String = ""
    public var direction: PortalDirection = .outboundTrigger

    public init() {}

    public func reset(at point: GridPoint) {
        x = point.x
        y = point.y
        width = SomnioConstants.tileSize
        height = SomnioConstants.tileSize
        targetSectorName = ""
        direction = .outboundTrigger
    }

    public func buildPortal() -> SectorPortal {
        SectorPortal(
            x: x,
            y: y,
            width: width,
            height: height,
            targetSectorName: targetSectorName,
            direction: direction
        )
    }
}
