import Foundation
import SomnioCore

/// Currently-selected record on the canvas. NPCs and monster spawns live in distinct
/// `SectorBody` arrays so the enum carries a separate case per array rather than a
/// merged "spawn" case — that keeps deletes and reconciles unambiguous when the editor
/// has to clamp the selection index against array bounds after a mutation.
public enum EditorSelection: Sendable, Equatable, Hashable {
    case object(Int)
    case mask(Int)
    case portal(Int)
    case npc(Int)
    case monsterSpawn(Int)
}

public extension EditorSelection {
    /// Looks up the selected record's bounds in `body`. Returns `nil` when the index has
    /// been invalidated (the record was deleted and `selection` was not yet cleared).
    /// Shared by the canvas hit-tester, the overlay highlight, and the HUD readout so
    /// future record types only need to extend this single switch.
    func bounds(in body: SectorBody) -> (origin: GridPoint, size: GridSize)? {
        switch self {
        case let .object(index):
            guard body.objects.indices.contains(index) else { return nil }
            let object = body.objects[index]
            return (GridPoint(x: object.x, y: object.y),
                    GridSize(width: object.sourceWidth, height: object.sourceHeight))
        case let .mask(index):
            guard body.collisionMasks.indices.contains(index) else { return nil }
            let mask = body.collisionMasks[index]
            return (GridPoint(x: mask.x, y: mask.y),
                    GridSize(width: mask.width, height: mask.height))
        case let .portal(index):
            guard body.portals.indices.contains(index) else { return nil }
            let portal = body.portals[index]
            return (GridPoint(x: portal.x, y: portal.y),
                    GridSize(width: portal.width, height: portal.height))
        case let .npc(index):
            guard body.npcs.indices.contains(index) else { return nil }
            let npc = body.npcs[index]
            return (npc.spawnOrigin, npc.spawnBoxSize)
        case let .monsterSpawn(index):
            guard body.monsterSpawns.indices.contains(index) else { return nil }
            let spawn = body.monsterSpawns[index]
            return (spawn.spawnOrigin, spawn.spawnBoxSize)
        }
    }

    /// True when the selection's index is still in range for the corresponding
    /// `SectorBody` array. Cheaper than `bounds(in:)` when callers only need to clamp
    /// after a mutation invalidates an index.
    func isValid(in body: SectorBody) -> Bool {
        switch self {
        case let .object(index): return body.objects.indices.contains(index)
        case let .mask(index): return body.collisionMasks.indices.contains(index)
        case let .portal(index): return body.portals.indices.contains(index)
        case let .npc(index): return body.npcs.indices.contains(index)
        case let .monsterSpawn(index): return body.monsterSpawns.indices.contains(index)
        }
    }

    /// Removes the selected record from `body`. Returns `true` if the index was valid
    /// (and the record was removed), `false` otherwise. Centralizes the index-bounds
    /// switch that the canvas-delete path used to repeat per case.
    @discardableResult
    func remove(from body: inout SectorBody) -> Bool {
        switch self {
        case let .object(index):
            guard body.objects.indices.contains(index) else { return false }
            body.objects.remove(at: index)
        case let .mask(index):
            guard body.collisionMasks.indices.contains(index) else { return false }
            body.collisionMasks.remove(at: index)
        case let .portal(index):
            guard body.portals.indices.contains(index) else { return false }
            body.portals.remove(at: index)
        case let .npc(index):
            guard body.npcs.indices.contains(index) else { return false }
            body.npcs.remove(at: index)
        case let .monsterSpawn(index):
            guard body.monsterSpawns.indices.contains(index) else { return false }
            body.monsterSpawns.remove(at: index)
        }
        return true
    }
}
