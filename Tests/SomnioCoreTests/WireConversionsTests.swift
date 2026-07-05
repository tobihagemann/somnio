import Foundation
import SomnioProtocol
import Testing
@testable import SomnioCore

// Bidirectional model↔wire round-trips for every type in `WireConversions.swift`.
// The non-trivial conversions are `SectorPortal` (throws `WireConversionError` on unknown
// directions, mirroring the codec path) and `InventoryRow` (`Hand?` ↔ `WireHand` with
// `.none` ↔ `nil`).

struct WireConversionsTests {
    @Test func `grid point round trip`() {
        let p = GridPoint(x: 5, y: 9)
        #expect(GridPoint(p.asWire) == p)
    }

    @Test func `grid size round trip`() {
        let s = GridSize(width: 10, height: 20)
        #expect(GridSize(s.asWire) == s)
    }

    @Test func `ground tile round trip`() {
        let g = GroundTile(tilesetIndex: 1, sourceX: 2, sourceY: 3)
        #expect(GroundTile(g.asWire) == g)
    }

    @Test func `light setting round trip`() {
        let l = LightSetting(indoor: true, brightness: 75)
        #expect(LightSetting(l.asWire) == l)
    }

    @Test func `object round trip`() {
        let o = Object(x: 1, y: 2, tilesetIndex: 3, sourceX: 4, sourceY: 5,
                       sourceWidth: 6, sourceHeight: 7, priority: 8)
        #expect(Object(o.asWire) == o)
    }

    @Test func `collision mask round trip`() {
        let m = CollisionMask(x: 1, y: 2, width: 3, height: 4)
        #expect(CollisionMask(m.asWire) == m)
    }

    @Test func `sector portal round trip preserves direction`() throws {
        for direction in PortalDirection.allCases {
            let p = SectorPortal(x: 0, y: 0, width: 1, height: 1,
                                 targetSectorName: "EdariaArena", direction: direction)
            #expect(try SectorPortal(p.asWire).direction == direction)
        }
    }

    @Test func `sector portal init throws on unknown direction`() {
        // Mirrors `MapCodec.read`'s loud failure on unknown direction raw values; iteration-2
        // fix to keep the wire path symmetric with the file path.
        let wire = WireSectorPortal(x: 0, y: 0, width: 1, height: 1,
                                    targetSectorName: "?", direction: 99)
        #expect(throws: WireConversionError.unknownPortalDirection(99)) {
            try SectorPortal(wire)
        }
    }

    @Test func `NPC round trip`() {
        let npc = NPC(
            spawnOrigin: GridPoint(x: 4, y: 5),
            spawnBoxSize: GridSize(width: 2, height: 2),
            maskSize: GridSize(width: 1, height: 1),
            name: "Libus", figure: 12, facing: Heading(degrees: 137.5), behaviorTag: 0,
            dialogScript: "Hallo!"
        )
        #expect(NPC(npc.asWire) == npc)
    }

    @Test func `monster spawn round trip`() {
        let m = MonsterSpawn(
            spawnOrigin: GridPoint(x: 1, y: 2),
            spawnBoxSize: GridSize(width: 4, height: 4),
            spawnedMonsterSize: GridSize(width: 1, height: 1),
            name: "Gespenst", figure: 99, bounded: true,
            spawnHP: 100, spawnBalance: 100, spawnMana: 100,
            aiScriptIndex: 3
        )
        #expect(MonsterSpawn(m.asWire) == m)
    }

    @Test func `inventory extra round trip`() {
        let e = InventoryExtra(key: "gold", value: 42)
        #expect(InventoryExtra(e.asWire) == e)
    }

    @Test func `inventory row round trip across all hand cases`() {
        for hand: Hand? in [nil, .left, .right] {
            let row = InventoryRow(slot: 7, category: 1, itemId: 99,
                                   extras: [InventoryExtra(key: "gold", value: 50)],
                                   equippedHand: hand)
            #expect(InventoryRow(row.asWire) == row)
        }
    }

    @Test func `inventory row hand maps Optional none to wire none`() {
        let row = InventoryRow(slot: 0, category: 0, itemId: 0, extras: [], equippedHand: nil)
        #expect(row.asWire.equippedHand == .none)
    }

    @Test func `sector round trip via wire`() throws {
        let sector = Sector(
            name: "EdariaArena",
            version: 1,
            dimensions: GridSize(width: 16, height: 16),
            ground: GroundTile(tilesetIndex: 1, sourceX: 2, sourceY: 3),
            light: LightSetting(indoor: true, brightness: 75),
            objects: [Object(x: 1, y: 1, tilesetIndex: 0, sourceX: 0, sourceY: 0,
                             sourceWidth: 1, sourceHeight: 1, priority: 0)],
            collisionMasks: [CollisionMask(x: 0, y: 0, width: 1, height: 1)],
            portals: [SectorPortal(x: 0, y: 0, width: 1, height: 1,
                                   targetSectorName: "EdariaMitte", direction: .arrivalPlacement)],
            npcs: [],
            monsterSpawns: []
        )
        #expect(try Sector(sector.asWire) == sector)
    }

    @Test func `sector init accepts dimensions at the boundary`() throws {
        // Width at the per-axis cap and height chosen so the product hits the area cap exactly:
        // accepted on both bounds at once.
        let height = Int16(SomnioConstants.maxSectorArea / Int32(SomnioConstants.maxSectorDimension))
        let wire = Self.wireSector(width: SomnioConstants.maxSectorDimension, height: height)
        #expect(try Sector(wire).dimensions == GridSize(width: SomnioConstants.maxSectorDimension, height: height))
    }

    @Test(arguments: [
        (Int16(0), Int16(16)),
        (Int16(-1), Int16(16)),
        (Int16(16), Int16(0)),
        (Int16(16), Int16(-1)),
        (SomnioConstants.maxSectorDimension + 1, Int16(16)),
        (Int16(16), Int16(SomnioConstants.maxSectorDimension + 1)),
        // Both axes within the per-axis cap but the product exceeds the area cap: isolates the
        // area guard (512 * 512 = 262144 > 65536).
        (Int16(512), Int16(512))
    ])
    func `sector init throws on out-of-range dimensions`(width: Int16, height: Int16) {
        // A hostile server could otherwise size the ground tile map from unbounded dimensions.
        let wire = Self.wireSector(width: width, height: height)
        #expect(throws: WireConversionError.sectorDimensionsOutOfRange(width: width, height: height)) {
            try Sector(wire)
        }
    }

    @Test func `sector init accepts content counts at the caps`() throws {
        let wire = Self.wireSector(
            objectCount: SomnioConstants.maxSectorObjects,
            maskCount: SomnioConstants.maxSectorCollisionMasks
        )
        let sector = try Sector(wire)
        #expect(sector.objects.count == SomnioConstants.maxSectorObjects)
        #expect(sector.collisionMasks.count == SomnioConstants.maxSectorCollisionMasks)
    }

    @Test(arguments: [
        (SomnioConstants.maxSectorObjects + 1, 0),
        (0, SomnioConstants.maxSectorCollisionMasks + 1)
    ])
    func `sector init throws on content counts over the caps`(objectCount: Int, maskCount: Int) {
        // The renderer's bottom-edge anchor scan is O(objects × collisionMasks), so a hostile
        // server could otherwise freeze the client with a single frame-sized sector.
        let wire = Self.wireSector(objectCount: objectCount, maskCount: maskCount)
        #expect(throws: WireConversionError.sectorContentCountsOutOfRange(objects: objectCount, collisionMasks: maskCount)) {
            try Sector(wire)
        }
    }

    private static func wireSector(width: Int16, height: Int16) -> WireSector {
        Sector(
            name: "EdariaArena",
            version: 1,
            dimensions: GridSize(width: width, height: height),
            ground: GroundTile(tilesetIndex: 1, sourceX: 2, sourceY: 3),
            light: LightSetting(indoor: true, brightness: 75)
        ).asWire
    }

    private static func wireSector(objectCount: Int, maskCount: Int) -> WireSector {
        Sector(
            name: "EdariaArena",
            version: 1,
            dimensions: GridSize(width: 16, height: 16),
            ground: GroundTile(tilesetIndex: 1, sourceX: 2, sourceY: 3),
            light: LightSetting(indoor: true, brightness: 75),
            objects: Array(
                repeating: Object(x: 0, y: 0, tilesetIndex: 0, sourceX: 0, sourceY: 0,
                                  sourceWidth: 1, sourceHeight: 1, priority: 0),
                count: objectCount
            ),
            collisionMasks: Array(repeating: CollisionMask(x: 0, y: 0, width: 1, height: 1), count: maskCount)
        ).asWire
    }
}
