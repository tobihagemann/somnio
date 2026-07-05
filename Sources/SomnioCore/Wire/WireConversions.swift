import Foundation
import SomnioProtocol

// Bidirectional conversions between `SomnioCore` runtime types and the `WireDTOs` declared
// in `SomnioProtocol`. Lives in `SomnioCore` (which depends on `SomnioProtocol`, so it can
// name both types) — *not* in `SomnioProtocol` (which is Foundation-only and cannot see
// `SomnioCore` types).

// MARK: - GridPoint

public extension GridPoint {
    init(_ wire: WireGridPoint) {
        self.init(x: wire.x, y: wire.y)
    }

    var asWire: WireGridPoint {
        WireGridPoint(x: x, y: y)
    }
}

// MARK: - GridSize

public extension GridSize {
    init(_ wire: WireGridSize) {
        self.init(width: wire.width, height: wire.height)
    }

    var asWire: WireGridSize {
        WireGridSize(width: width, height: height)
    }
}

// MARK: - GroundTile

public extension GroundTile {
    init(_ wire: WireGroundTile) {
        self.init(tilesetIndex: wire.tilesetIndex, sourceX: wire.sourceX, sourceY: wire.sourceY)
    }

    var asWire: WireGroundTile {
        WireGroundTile(tilesetIndex: tilesetIndex, sourceX: sourceX, sourceY: sourceY)
    }
}

// MARK: - LightSetting

public extension LightSetting {
    init(_ wire: WireLightSetting) {
        self.init(indoor: wire.indoor, brightness: wire.brightness)
    }

    var asWire: WireLightSetting {
        WireLightSetting(indoor: indoor, brightness: brightness)
    }
}

// MARK: - Object

public extension Object {
    init(_ wire: WireObject) {
        self.init(
            x: wire.x, y: wire.y,
            tilesetIndex: wire.tilesetIndex, sourceX: wire.sourceX, sourceY: wire.sourceY,
            sourceWidth: wire.sourceWidth, sourceHeight: wire.sourceHeight,
            priority: wire.priority
        )
    }

    var asWire: WireObject {
        WireObject(
            x: x, y: y,
            tilesetIndex: tilesetIndex, sourceX: sourceX, sourceY: sourceY,
            sourceWidth: sourceWidth, sourceHeight: sourceHeight,
            priority: priority
        )
    }
}

// MARK: - CollisionMask

public extension CollisionMask {
    init(_ wire: WireCollisionMask) {
        self.init(x: wire.x, y: wire.y, width: wire.width, height: wire.height)
    }

    var asWire: WireCollisionMask {
        WireCollisionMask(x: x, y: y, width: width, height: height)
    }
}

// MARK: - SectorPortal

public extension SectorPortal {
    /// Throws `WireConversionError.unknownPortalDirection` for unknown raw values so client-side
    /// wire decoding fails just as loudly as editor/server-side file decoding, where `MapCodec`'s
    /// synthesized `PortalDirection` `Codable` rejects the same out-of-range value as a
    /// `DecodingError`.
    init(_ wire: WireSectorPortal) throws {
        guard let direction = PortalDirection(rawValue: wire.direction) else {
            throw WireConversionError.unknownPortalDirection(Int(wire.direction))
        }
        self.init(
            x: wire.x, y: wire.y, width: wire.width, height: wire.height,
            targetSectorName: wire.targetSectorName,
            direction: direction
        )
    }

    var asWire: WireSectorPortal {
        WireSectorPortal(
            x: x, y: y, width: width, height: height,
            targetSectorName: targetSectorName,
            direction: direction.rawValue
        )
    }
}

public enum WireConversionError: Error, Equatable, Sendable {
    case unknownPortalDirection(Int)
    case sectorDimensionsOutOfRange(width: Int16, height: Int16)
    case sectorContentCountsOutOfRange(objects: Int, collisionMasks: Int)
}

// MARK: - NPC

public extension NPC {
    init(_ wire: WireNPC) {
        self.init(
            spawnOrigin: GridPoint(x: wire.spawnX, y: wire.spawnY),
            spawnBoxSize: GridSize(width: wire.spawnBoxWidth, height: wire.spawnBoxHeight),
            maskSize: GridSize(width: wire.maskWidth, height: wire.maskHeight),
            name: wire.name,
            figure: wire.figure,
            direction: wire.direction,
            behaviorTag: wire.behaviorTag,
            dialogScript: wire.dialogScript
        )
    }

    var asWire: WireNPC {
        WireNPC(
            spawnX: spawnOrigin.x, spawnY: spawnOrigin.y,
            spawnBoxWidth: spawnBoxSize.width, spawnBoxHeight: spawnBoxSize.height,
            maskWidth: maskSize.width, maskHeight: maskSize.height,
            name: name, figure: figure, direction: direction,
            behaviorTag: behaviorTag, dialogScript: dialogScript
        )
    }
}

// MARK: - MonsterSpawn

public extension MonsterSpawn {
    init(_ wire: WireMonsterSpawn) {
        self.init(
            spawnOrigin: GridPoint(x: wire.spawnX, y: wire.spawnY),
            spawnBoxSize: GridSize(width: wire.spawnBoxWidth, height: wire.spawnBoxHeight),
            spawnedMonsterSize: GridSize(width: wire.monsterWidth, height: wire.monsterHeight),
            name: wire.name,
            figure: wire.figure,
            bounded: wire.bounded,
            spawnHP: wire.spawnHP,
            spawnBalance: wire.spawnBalance,
            spawnMana: wire.spawnMana,
            aiScriptIndex: wire.aiScriptIndex
        )
    }

    var asWire: WireMonsterSpawn {
        WireMonsterSpawn(
            spawnX: spawnOrigin.x, spawnY: spawnOrigin.y,
            spawnBoxWidth: spawnBoxSize.width, spawnBoxHeight: spawnBoxSize.height,
            monsterWidth: spawnedMonsterSize.width, monsterHeight: spawnedMonsterSize.height,
            name: name, figure: figure, bounded: bounded,
            spawnHP: spawnHP, spawnBalance: spawnBalance, spawnMana: spawnMana,
            aiScriptIndex: aiScriptIndex
        )
    }
}

// MARK: - Sector

public extension Sector {
    /// Throws `WireConversionError.sectorDimensionsOutOfRange` when a peer sends a sector whose
    /// tile dimensions are non-positive, exceed `SomnioConstants.maxSectorDimension` per axis, or
    /// exceed `SomnioConstants.maxSectorArea` in total, so a hostile server can't drive the client
    /// into an unbounded ground-tile-map / entity-graph allocation. Throws
    /// `.sectorContentCountsOutOfRange` when the object or collision-mask arrays exceed their
    /// caps — the renderer's bottom-edge anchor scan is O(objects × collisionMasks), so counts a
    /// frame-sized payload can still carry would freeze the client.
    init(_ wire: WireSector) throws {
        let dimensions = GridSize(wire.dimensions)
        guard dimensions.isWithinSectorBounds else {
            throw WireConversionError.sectorDimensionsOutOfRange(width: dimensions.width, height: dimensions.height)
        }
        guard SomnioConstants.isWithinSectorContentBounds(
            objectCount: wire.objects.count, collisionMaskCount: wire.collisionMasks.count
        ) else {
            throw WireConversionError.sectorContentCountsOutOfRange(
                objects: wire.objects.count, collisionMasks: wire.collisionMasks.count
            )
        }
        try self.init(
            name: wire.name,
            version: wire.version,
            dimensions: dimensions,
            ground: GroundTile(wire.ground),
            light: LightSetting(wire.light),
            objects: wire.objects.map(Object.init),
            collisionMasks: wire.collisionMasks.map(CollisionMask.init),
            portals: wire.portals.map(SectorPortal.init),
            npcs: wire.npcs.map(NPC.init),
            monsterSpawns: wire.monsterSpawns.map(MonsterSpawn.init)
        )
    }

    var asWire: WireSector {
        WireSector(
            name: name,
            version: version,
            dimensions: dimensions.asWire,
            ground: ground.asWire,
            light: light.asWire,
            objects: objects.map(\.asWire),
            collisionMasks: collisionMasks.map(\.asWire),
            portals: portals.map(\.asWire),
            npcs: npcs.map(\.asWire),
            monsterSpawns: monsterSpawns.map(\.asWire)
        )
    }
}

// MARK: - Inventory

public extension InventoryExtra {
    init(_ wire: WireInventoryExtra) {
        self.init(key: wire.key, value: wire.value)
    }

    var asWire: WireInventoryExtra {
        WireInventoryExtra(key: key, value: value)
    }
}

public extension InventoryRow {
    init(_ wire: WireInventoryRow) {
        let hand: Hand? = switch wire.equippedHand {
        case .none: nil
        case .left: .left
        case .right: .right
        }
        self.init(
            slot: wire.slot,
            category: wire.category,
            itemId: wire.itemId,
            extras: wire.extras.map(InventoryExtra.init),
            equippedHand: hand
        )
    }

    var asWire: WireInventoryRow {
        let hand: WireHand = switch equippedHand {
        case .none: .none
        case .left: .left
        case .right: .right
        }
        return WireInventoryRow(
            slot: slot,
            category: category,
            itemId: itemId,
            extras: extras.map(\.asWire),
            equippedHand: hand
        )
    }
}
