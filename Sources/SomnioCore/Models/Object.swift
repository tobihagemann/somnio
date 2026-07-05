import Foundation

/// One placed prop. `modelID` references the model registry's semantic object ids;
/// an unknown id resolves to a placeholder rather than rejecting the sector.
/// `sourceWidth`/`sourceHeight` are the authored footprint extent in legacy pixels —
/// placement math anchors the model's ground footprint to this rect, and the prop
/// pipeline width-fits architecture models against `sourceWidth`.
public struct Object: Sendable, Equatable, Hashable, Codable {
    public var x: Int16
    public var y: Int16
    public var modelID: String
    public var sourceWidth: Int16
    public var sourceHeight: Int16
    public var priority: Int16

    public init(
        x: Int16,
        y: Int16,
        modelID: String,
        sourceWidth: Int16,
        sourceHeight: Int16,
        priority: Int16
    ) {
        self.x = x
        self.y = y
        self.modelID = modelID
        self.sourceWidth = sourceWidth
        self.sourceHeight = sourceHeight
        self.priority = priority
    }
}
