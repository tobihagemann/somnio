import Foundation

public struct Object: Sendable, Equatable, Hashable, Codable {
    public var x: Int16
    public var y: Int16
    public var tilesetIndex: Int16
    public var sourceX: Int16
    public var sourceY: Int16
    public var sourceWidth: Int16
    public var sourceHeight: Int16
    public var priority: Int16

    public init(
        x: Int16,
        y: Int16,
        tilesetIndex: Int16,
        sourceX: Int16,
        sourceY: Int16,
        sourceWidth: Int16,
        sourceHeight: Int16,
        priority: Int16
    ) {
        self.x = x
        self.y = y
        self.tilesetIndex = tilesetIndex
        self.sourceX = sourceX
        self.sourceY = sourceY
        self.sourceWidth = sourceWidth
        self.sourceHeight = sourceHeight
        self.priority = priority
    }
}
