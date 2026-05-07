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
}
