import Foundation

public struct NPC: Sendable, Equatable, Hashable {
    public var spawnOrigin: GridPoint
    public var spawnBoxSize: GridSize
    public var maskSize: GridSize
    public var name: String
    public var figure: Int16
    public var direction: Int16
    public var behaviorTag: Int16
    public var dialogScript: String

    public init(
        spawnOrigin: GridPoint,
        spawnBoxSize: GridSize,
        maskSize: GridSize,
        name: String,
        figure: Int16,
        direction: Int16,
        behaviorTag: Int16,
        dialogScript: String
    ) {
        self.spawnOrigin = spawnOrigin
        self.spawnBoxSize = spawnBoxSize
        self.maskSize = maskSize
        self.name = name
        self.figure = figure
        self.direction = direction
        self.behaviorTag = behaviorTag
        self.dialogScript = dialogScript
    }
}
