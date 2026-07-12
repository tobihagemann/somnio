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

    /// The raw array index, for source-order sorting within a kind (the kinds live in
    /// separate arrays, so cross-kind order is irrelevant).
    var sourceIndex: Int {
        switch self {
        case let .object(index): return index
        case let .mask(index): return index
        case let .portal(index): return index
        case let .npc(index): return index
        case let .monsterSpawn(index): return index
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

    /// Removes every selected record from `body` in one pass. `Set` iteration is unordered
    /// and each removal shifts the indices behind it, so the selections are partitioned by
    /// kind and each kind's indices removed in **descending** order — ascending removal would
    /// delete the wrong records or trap out of range.
    static func removeAll(_ selections: some Collection<EditorSelection>, from body: inout SectorBody) {
        var objects: [Int] = []
        var masks: [Int] = []
        var portals: [Int] = []
        var npcs: [Int] = []
        var monsterSpawns: [Int] = []
        for selection in selections {
            switch selection {
            case let .object(index): objects.append(index)
            case let .mask(index): masks.append(index)
            case let .portal(index): portals.append(index)
            case let .npc(index): npcs.append(index)
            case let .monsterSpawn(index): monsterSpawns.append(index)
            }
        }
        removeDescending(objects, from: &body.objects)
        removeDescending(masks, from: &body.collisionMasks)
        removeDescending(portals, from: &body.portals)
        removeDescending(npcs, from: &body.npcs)
        removeDescending(monsterSpawns, from: &body.monsterSpawns)
    }

    private static func removeDescending(_ indices: [Int], from records: inout [some Any]) {
        for index in indices.sorted(by: >) where records.indices.contains(index) {
            records.remove(at: index)
        }
    }
}
