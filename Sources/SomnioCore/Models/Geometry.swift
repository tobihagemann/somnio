import Foundation

public struct GridPoint: Sendable, Equatable, Hashable, Codable {
    public var x: Int16
    public var y: Int16

    public init(x: Int16, y: Int16) {
        self.x = x
        self.y = y
    }
}

public struct GridSize: Sendable, Equatable, Hashable, Codable {
    public var width: Int16
    public var height: Int16

    public init(width: Int16, height: Int16) {
        self.width = width
        self.height = height
    }

    /// True when these tile dimensions are a valid sector size: positive, within
    /// `SomnioConstants.maxSectorDimension` per axis, and within `SomnioConstants.maxSectorArea`
    /// total — the shared bound the disk codec and the wire boundary each gate on. The `Int32`
    /// area product can't overflow: `Int16` operands cap it at ~1.07e9, well under `Int32.max`.
    var isWithinSectorBounds: Bool {
        width >= 1 && height >= 1
            && width <= SomnioConstants.maxSectorDimension
            && height <= SomnioConstants.maxSectorDimension
            && Int32(width) * Int32(height) <= SomnioConstants.maxSectorArea
    }
}

public struct GroundTile: Sendable, Equatable, Hashable, Codable {
    public var tilesetIndex: Int16
    public var sourceX: Int16
    public var sourceY: Int16

    public init(tilesetIndex: Int16, sourceX: Int16, sourceY: Int16) {
        self.tilesetIndex = tilesetIndex
        self.sourceX = sourceX
        self.sourceY = sourceY
    }
}

public struct LightSetting: Sendable, Equatable, Hashable, Codable {
    public var indoor: Bool
    public var brightness: Int16

    public init(indoor: Bool, brightness: Int16) {
        self.indoor = indoor
        self.brightness = brightness
    }
}
