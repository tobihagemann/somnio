import Foundation
import SomnioMapFixturesTestSupport
import Testing
@testable import SomnioCore

struct MapCodecRoundTripTests {
    private func roundTrip(_ name: MapFixtures.Name) throws {
        let bytes = try MapFixtures.data(name)
        let original = try MapCodec.read(bytes)
        let rewrittenBytes = try MapCodec.write(original)
        let rewritten = try MapCodec.read(rewrittenBytes)
        #expect(rewritten == original)
    }

    @Test func `edaria mitte round trips`() throws {
        try roundTrip(.edariaMitte)
    }

    @Test func `edaria arena round trips`() throws {
        try roundTrip(.edariaArena)
    }

    @Test func `edaria bibliothek round trips`() throws {
        try roundTrip(.edariaBibliothek)
    }

    @Test func `edaria mitte has four portals and is unpopulated`() throws {
        let sector = try MapCodec.read(MapFixtures.data(.edariaMitte))
        #expect(sector.portals.count == 4)
        #expect(sector.npcs.isEmpty)
        #expect(sector.monsterSpawns.isEmpty)
        #expect(sector.light.indoor == false)
    }

    @Test func `edaria arena has gespenst with uncorrupted balance`() throws {
        let sector = try MapCodec.read(MapFixtures.data(.edariaArena))
        #expect(sector.light.indoor == true)
        #expect(sector.light.brightness == 75)
        #expect(sector.monsterSpawns.count == 1)
        let gespenst = sector.monsterSpawns[0]
        #expect(gespenst.name == "Gespenst")
        // The corrected layout (canonical port behavior) reads balance at +23 + Byte(16),
        // not the legacy off-by-one +22. The fixture stores leben = balance = mana = 100.
        #expect(gespenst.spawnHP == 100)
        #expect(gespenst.spawnBalance == 100)
        #expect(gespenst.spawnMana == 100)
    }

    @Test func `edaria bibliothek has libus NPC`() throws {
        let sector = try MapCodec.read(MapFixtures.data(.edariaBibliothek))
        #expect(sector.light.indoor == true)
        #expect(sector.light.brightness == 100)
        #expect(sector.npcs.count == 1)
        let libus = sector.npcs[0]
        #expect(libus.name == "Libus")
        #expect(libus.dialogScript.contains("$name"))
    }

    @Test func `write emits canonical record ordering`() throws {
        // Pin the writer's documented order: version → sectorHeader → objects → masks →
        // portals → NPCs → monsterSpawns. Reordering would silently survive every other
        // round-trip test because `read` is order-agnostic.
        let body = SectorBody(
            version: 1,
            dimensions: GridSize(width: 4, height: 4),
            ground: GroundTile(tilesetIndex: 0, sourceX: 0, sourceY: 0),
            light: LightSetting(indoor: false, brightness: 100),
            objects: [Object(x: 0, y: 0, tilesetIndex: 0, sourceX: 0, sourceY: 0,
                             sourceWidth: 1, sourceHeight: 1, priority: 0)],
            collisionMasks: [CollisionMask(x: 0, y: 0, width: 1, height: 1)],
            portals: [SectorPortal(x: 0, y: 0, width: 1, height: 1,
                                   targetSectorName: "Other", direction: .outboundTrigger)],
            npcs: [NPC(spawnOrigin: GridPoint(x: 1, y: 1),
                       spawnBoxSize: GridSize(width: 1, height: 1),
                       maskSize: GridSize(width: 1, height: 1),
                       name: "X", figure: 0, direction: 0, behaviorTag: 0,
                       dialogScript: "")],
            monsterSpawns: [MonsterSpawn(spawnOrigin: GridPoint(x: 2, y: 2),
                                         spawnBoxSize: GridSize(width: 1, height: 1),
                                         spawnedMonsterSize: GridSize(width: 1, height: 1),
                                         name: "M", figure: 0, bounded: true,
                                         spawnHP: 1, spawnBalance: 1, spawnMana: 1,
                                         aiScriptIndex: 0)]
        )
        let bytes = try MapCodec.write(body)
        let recordTypes = parseRecordTypeSequence(bytes)
        // version=0, sectorHeader=1, object=2, collisionMask=3, sectorPortal=4,
        // npcOrMonsterSpawn=5 (NPC), npcOrMonsterSpawn=5 (MonsterSpawn).
        #expect(recordTypes == [0, 1, 2, 3, 4, 5, 5])
    }

    private func parseRecordTypeSequence(_ data: Data) -> [Int] {
        var offset = data.startIndex
        var types: [Int] = []
        while offset + 4 <= data.endIndex {
            let length = Int(data[offset]) | (Int(data[offset + 1]) << 8)
            let typeRaw = Int(data[offset + 2]) | (Int(data[offset + 3]) << 8)
            types.append(typeRaw)
            offset += length + 2
        }
        return types
    }

    /// Regression guard for the centering-in-codec class of bug. `MapCodec.read` returns the
    /// file's authored `spawnOrigin` value, not a centered runtime position, and
    /// `NPCPlacement.runtimePosition(for:)` produces the legacy-equivalent centered coordinate.
    @Test func `npc spawn origin is raw not centered`() throws {
        let sector = try MapCodec.read(MapFixtures.data(.edariaBibliothek))
        let libus = sector.npcs[0]
        let runtime = NPCPlacement.runtimePosition(for: libus)
        let expectedRuntimeX = libus.spawnOrigin.x + (libus.spawnBoxSize.width - libus.maskSize.width) / 2
        let expectedRuntimeY = libus.spawnOrigin.y + (libus.spawnBoxSize.height - libus.maskSize.height) / 2
        #expect(runtime.x == expectedRuntimeX)
        #expect(runtime.y == expectedRuntimeY)
        // The codec must not have folded centering into spawnOrigin: if spawn box and mask
        // size differ, runtime position differs from spawnOrigin.
        if libus.spawnBoxSize != libus.maskSize {
            #expect(GridPoint(x: runtime.x, y: runtime.y) != libus.spawnOrigin)
        }
    }
}
