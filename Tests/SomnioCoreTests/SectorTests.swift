import Foundation
import Testing
@testable import SomnioCore

// `Sector(body:, name:)` and `Sector.body` form a round-trip pairing: the parser returns a
// `SectorBody`, the caller wraps it with a name, and the computed `body` should reproduce the
// original. Direct test so a future field-drop in either direction trips a regression here
// rather than only via a MapCodec round-trip.

struct SectorTests {
    private func makeBody() -> SectorBody {
        SectorBody(
            version: 3,
            dimensions: GridSize(width: 8, height: 8),
            ground: GroundTile(tilesetIndex: 1, sourceX: 2, sourceY: 3),
            light: LightSetting(indoor: true, brightness: 75),
            objects: [Object(x: 0, y: 1, tilesetIndex: 0, sourceX: 0, sourceY: 0,
                             sourceWidth: 1, sourceHeight: 1, priority: 0)],
            collisionMasks: [CollisionMask(x: 0, y: 0, width: 1, height: 1)],
            portals: [SectorPortal(x: 0, y: 0, width: 1, height: 1,
                                   targetSectorName: "Other", direction: .arrivalPlacement)],
            npcs: [NPC(spawnOrigin: GridPoint(x: 1, y: 2),
                       spawnBoxSize: GridSize(width: 2, height: 2),
                       maskSize: GridSize(width: 1, height: 1),
                       name: "Libus", figure: 12, direction: 1, behaviorTag: 0,
                       dialogScript: "Hi.")],
            monsterSpawns: [MonsterSpawn(spawnOrigin: GridPoint(x: 3, y: 3),
                                         spawnBoxSize: GridSize(width: 2, height: 2),
                                         spawnedMonsterSize: GridSize(width: 1, height: 1),
                                         name: "Gespenst", figure: 99, bounded: true,
                                         spawnHP: 100, spawnBalance: 100, spawnMana: 100,
                                         aiScriptIndex: 3)]
        )
    }

    @Test func `body init wraps every field`() {
        let body = makeBody()
        let sector = Sector(body: body, name: "EdariaArena")

        #expect(sector.name == "EdariaArena")
        #expect(sector.version == body.version)
        #expect(sector.dimensions == body.dimensions)
        #expect(sector.ground == body.ground)
        #expect(sector.light == body.light)
        #expect(sector.objects == body.objects)
        #expect(sector.collisionMasks == body.collisionMasks)
        #expect(sector.portals == body.portals)
        #expect(sector.npcs == body.npcs)
        #expect(sector.monsterSpawns == body.monsterSpawns)
    }

    @Test func `body computed property round trips`() {
        let body = makeBody()
        let sector = Sector(body: body, name: "round-trip")
        #expect(sector.body == body)
    }

    @Test func `pixel extent of a SectorBody multiplies tiles by the tile size and mirrors Sector`() {
        let body = SectorBody(
            version: 1,
            dimensions: GridSize(width: 8, height: 12),
            ground: GroundTile(tilesetIndex: 0, sourceX: 0, sourceY: 0),
            light: LightSetting(indoor: true, brightness: 100)
        )
        #expect(body.pixelWidth == 8 * Int32(SomnioConstants.tileSize))
        #expect(body.pixelHeight == 12 * Int32(SomnioConstants.tileSize))
        let sector = Sector(body: body, name: "S")
        #expect(body.pixelWidth == sector.pixelWidth)
        #expect(body.pixelHeight == sector.pixelHeight)
    }

    @Test func `pixel extent widens past Int16 for large sectors`() {
        // 300 tiles * 128 = 38400, beyond Int16.max — the Int32 widening must not trap or overflow.
        let body = SectorBody(
            version: 1,
            dimensions: GridSize(width: 300, height: 1),
            ground: GroundTile(tilesetIndex: 0, sourceX: 0, sourceY: 0),
            light: LightSetting(indoor: true, brightness: 100)
        )
        #expect(body.pixelWidth == 38400)
    }

    @Test func `arrivalSpawn is nil without a self-targeting arrival portal`() {
        // The only portal targets a different sector, so it is not "S"'s arrival point.
        let sector = makeArrivalSector(
            portals: [SectorPortal(x: 0, y: 0, width: 128, height: 128,
                                   targetSectorName: "Other", direction: .arrivalPlacement)]
        )
        #expect(sector.arrivalSpawn == nil)
    }

    @Test func `arrivalSpawn returns the portal center when it is walkable`() {
        let sector = makeArrivalSector(
            portals: [selfPortal(x: 0, y: 0, width: 128, height: 128)]
        )
        #expect(sector.arrivalSpawn == GridPoint(x: 64, y: 64))
    }

    @Test func `arrivalSpawn scans for a walkable cell when the center is masked`() throws {
        let mask = CollisionMask(x: 60, y: 60, width: 68, height: 68) // covers center (64, 64)
        let sector = makeArrivalSector(
            collisionMasks: [mask],
            portals: [selfPortal(x: 0, y: 0, width: 128, height: 128)]
        )
        #expect(CollisionMaskOverlap.contains(GridPoint(x: 64, y: 64), in: [mask]))
        let spawn = try #require(sector.arrivalSpawn)
        #expect(spawn != GridPoint(x: 64, y: 64))
        #expect(!CollisionMaskOverlap.contains(spawn, in: [mask]))
        #expect(spawn.x >= 0 && spawn.x < 128 && spawn.y >= 0 && spawn.y < 128)
    }

    @Test func `arrivalSpawn falls back to the portal center when fully masked`() {
        let sector = makeArrivalSector(
            collisionMasks: [CollisionMask(x: 0, y: 0, width: 128, height: 128)],
            portals: [selfPortal(x: 0, y: 0, width: 128, height: 128)]
        )
        #expect(sector.arrivalSpawn == GridPoint(x: 64, y: 64))
    }

    private func selfPortal(x: Int16, y: Int16, width: Int16, height: Int16) -> SectorPortal {
        SectorPortal(x: x, y: y, width: width, height: height,
                     targetSectorName: "S", direction: .arrivalPlacement)
    }

    private func makeArrivalSector(
        collisionMasks: [CollisionMask] = [],
        portals: [SectorPortal] = []
    ) -> Sector {
        Sector(
            name: "S",
            version: 1,
            dimensions: GridSize(width: 4, height: 4),
            ground: GroundTile(tilesetIndex: 0, sourceX: 0, sourceY: 0),
            light: LightSetting(indoor: true, brightness: 100),
            collisionMasks: collisionMasks,
            portals: portals
        )
    }
}
