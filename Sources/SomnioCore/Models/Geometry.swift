import Foundation

public struct GridPoint: Sendable, Equatable, Hashable {
    public var x: Int16
    public var y: Int16

    public init(x: Int16, y: Int16) {
        self.x = x
        self.y = y
    }
}

public struct GridSize: Sendable, Equatable, Hashable {
    public var width: Int16
    public var height: Int16

    public init(width: Int16, height: Int16) {
        self.width = width
        self.height = height
    }
}

public struct GroundTile: Sendable, Equatable, Hashable {
    public var tilesetIndex: Int16
    public var sourceX: Int16
    public var sourceY: Int16

    public init(tilesetIndex: Int16, sourceX: Int16, sourceY: Int16) {
        self.tilesetIndex = tilesetIndex
        self.sourceX = sourceX
        self.sourceY = sourceY
    }
}

public struct LightSetting: Sendable, Equatable, Hashable {
    public var indoor: Bool
    public var brightness: Int16

    public init(indoor: Bool, brightness: Int16) {
        self.indoor = indoor
        self.brightness = brightness
    }
}
