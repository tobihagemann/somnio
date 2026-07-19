import Foundation

/// One placed prop. `modelID` references the model registry's semantic object ids;
/// an unknown id resolves to a placeholder rather than rejecting the sector.
/// `sourceWidth`/`sourceHeight` are the authored footprint extent in legacy pixels —
/// placement math anchors the model's ground footprint to this rect, and the prop
/// pipeline width-fits architecture models against `sourceWidth`. `rotation` is a yaw
/// in degrees counter-clockwise seen from above (0 = as authored, 90 turns the +X face
/// north); a rotated placement's footprint rect must carry the rotated extents, since
/// the width-fit contract applies to the unrotated model.
public struct Object: Sendable, Equatable, Hashable, Codable {
    public var x: Int16
    public var y: Int16
    public var modelID: String
    public var sourceWidth: Int16
    public var sourceHeight: Int16
    public var priority: Int16
    public var rotation: Int16

    public init(
        x: Int16,
        y: Int16,
        modelID: String,
        sourceWidth: Int16,
        sourceHeight: Int16,
        priority: Int16,
        rotation: Int16 = 0
    ) {
        self.x = x
        self.y = y
        self.modelID = modelID
        self.sourceWidth = sourceWidth
        self.sourceHeight = sourceHeight
        self.priority = priority
        self.rotation = rotation
    }

    private enum CodingKeys: String, CodingKey {
        case x, y, modelID, sourceWidth, sourceHeight, priority, rotation
    }

    /// A missing `rotation` decodes as 0 and 0 is omitted on encode, so pre-rotation
    /// sector files decode unchanged and unrotated objects add no key noise.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            x: container.decode(Int16.self, forKey: .x),
            y: container.decode(Int16.self, forKey: .y),
            modelID: container.decode(String.self, forKey: .modelID),
            sourceWidth: container.decode(Int16.self, forKey: .sourceWidth),
            sourceHeight: container.decode(Int16.self, forKey: .sourceHeight),
            priority: container.decode(Int16.self, forKey: .priority),
            rotation: container.decodeIfPresent(Int16.self, forKey: .rotation) ?? 0
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(x, forKey: .x)
        try container.encode(y, forKey: .y)
        try container.encode(modelID, forKey: .modelID)
        try container.encode(sourceWidth, forKey: .sourceWidth)
        try container.encode(sourceHeight, forKey: .sourceHeight)
        try container.encode(priority, forKey: .priority)
        if rotation != 0 {
            try container.encode(rotation, forKey: .rotation)
        }
    }
}
