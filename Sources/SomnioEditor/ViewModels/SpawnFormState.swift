import Foundation
import SomnioCore

/// Spawn-dialog state covers both NPCs and monster spawns; `variant` toggles between
/// the two `SectorBody` arrays the OK handler appends into. NPC-only fields persist
/// across a variant switch so authors don't lose typed-in script text when comparing
/// the two flows.
public enum EditorSpawnVariant: String, CaseIterable, Identifiable, Sendable {
    case npc
    case monster

    public var id: Self {
        self
    }
}

@Observable public final class SpawnFormState {
    public var variant: EditorSpawnVariant = .npc

    public var spawnOrigin: GridPoint = .init(x: 0, y: 0)
    public var spawnBoxSize: GridSize = .init(width: SomnioConstants.tileSize, height: SomnioConstants.tileSize)
    public var maskSize: GridSize = .init(width: SomnioConstants.tileSize, height: SomnioConstants.tileSize)
    public var name: String = ""
    public var figure: Int16 = 0

    // NPC-only
    public var direction: Direction = .south
    public var behaviorTag: Int16 = 0
    public var dialogScript: String = ""

    // Monster-only
    public var bounded: Bool = true
    public var spawnHP: Int16 = 100
    public var spawnBalance: Int16 = 100
    public var spawnMana: Int16 = 100
    public var aiScriptIndex: Int16 = 0

    public init() {}

    public func reset(at point: GridPoint) {
        variant = .npc
        spawnOrigin = point
        spawnBoxSize = GridSize(width: SomnioConstants.tileSize, height: SomnioConstants.tileSize)
        maskSize = GridSize(width: SomnioConstants.tileSize, height: SomnioConstants.tileSize)
        name = ""
        figure = 0
        direction = .south
        behaviorTag = 0
        dialogScript = ""
        bounded = true
        spawnHP = 100
        spawnBalance = 100
        spawnMana = 100
        aiScriptIndex = 0
    }

    public func buildNPC() -> NPC {
        NPC(
            spawnOrigin: spawnOrigin,
            spawnBoxSize: spawnBoxSize,
            maskSize: maskSize,
            name: name,
            figure: figure,
            direction: direction.rawValue,
            behaviorTag: behaviorTag,
            dialogScript: dialogScript
        )
    }

    public func buildMonsterSpawn() -> MonsterSpawn {
        MonsterSpawn(
            spawnOrigin: spawnOrigin,
            spawnBoxSize: spawnBoxSize,
            spawnedMonsterSize: maskSize,
            name: name,
            figure: figure,
            bounded: bounded,
            spawnHP: spawnHP,
            spawnBalance: spawnBalance,
            spawnMana: spawnMana,
            aiScriptIndex: aiScriptIndex
        )
    }
}
