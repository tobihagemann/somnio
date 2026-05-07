import Foundation

public struct MonsterSpawn: Sendable, Equatable, Hashable {
    public var spawnOrigin: GridPoint
    public var spawnBoxSize: GridSize
    public var spawnedMonsterSize: GridSize
    public var name: String
    public var figure: Int16
    public var bounded: Bool
    public var spawnHP: Int16
    public var spawnBalance: Int16
    public var spawnMana: Int16
    public var aiScriptIndex: Int16

    public init(
        spawnOrigin: GridPoint,
        spawnBoxSize: GridSize,
        spawnedMonsterSize: GridSize,
        name: String,
        figure: Int16,
        bounded: Bool,
        spawnHP: Int16,
        spawnBalance: Int16,
        spawnMana: Int16,
        aiScriptIndex: Int16
    ) {
        self.spawnOrigin = spawnOrigin
        self.spawnBoxSize = spawnBoxSize
        self.spawnedMonsterSize = spawnedMonsterSize
        self.name = name
        self.figure = figure
        self.bounded = bounded
        self.spawnHP = spawnHP
        self.spawnBalance = spawnBalance
        self.spawnMana = spawnMana
        self.aiScriptIndex = aiScriptIndex
    }
}
