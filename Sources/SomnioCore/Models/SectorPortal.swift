import Foundation

public enum PortalDirection: Int16, Sendable, Equatable, Hashable, CaseIterable {
    case outboundTrigger = 0
    case arrivalPlacement = 1
}

public struct SectorPortal: Sendable, Equatable, Hashable {
    public var x: Int16
    public var y: Int16
    public var width: Int16
    public var height: Int16
    public var targetSectorName: String
    public var direction: PortalDirection

    public init(
        x: Int16,
        y: Int16,
        width: Int16,
        height: Int16,
        targetSectorName: String,
        direction: PortalDirection
    ) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.targetSectorName = targetSectorName
        self.direction = direction
    }
}
