import Foundation
import SomnioMapFixturesTestSupport
import Testing
@testable import SomnioCore

/// Golden tests for the committed `.somnio-sector` fixtures: they pin each sector's semantic
/// values, full collection counts, and portal routing so a dropped array, a wrong or hand-edited
/// file, or a regressed codec can't slip through.
struct SectorJSONGoldenTests {
    @Test(arguments: MapFixtures.Name.allCases)
    func `fixture survives an encode then decode round-trip`(_ name: MapFixtures.Name) throws {
        let decoded = try MapCodec.read(MapFixtures.data(name))
        let reDecoded = try MapCodec.read(MapCodec.write(decoded))
        #expect(reDecoded == decoded)
    }

    @Test func `edaria mitte golden`() throws {
        let sector = try MapCodec.read(MapFixtures.data(.edariaMitte))
        #expect(sector.version == 7)
        #expect(sector.dimensions == GridSize(width: 12, height: 12))
        #expect(sector.ground == GroundTile(tilesetIndex: 0, sourceX: 0, sourceY: 0))
        #expect(sector.light == LightSetting(indoor: false, brightness: 100))
        #expect(sector.objects.count == 2)
        #expect(sector.collisionMasks.count == 2)
        #expect(sector.npcs.isEmpty)
        #expect(sector.monsterSpawns.isEmpty)
        // Full portal records — routing and placement geometry counts alone can't protect.
        #expect(sector.portals == [
            SectorPortal(x: 1408, y: 184, width: 32, height: 8, targetSectorName: "EdariaBibliothek", direction: .outboundTrigger),
            SectorPortal(x: 1344, y: 208, width: 160, height: 96, targetSectorName: "EdariaBibliothek", direction: .arrivalPlacement),
            SectorPortal(x: 1120, y: 184, width: 32, height: 8, targetSectorName: "EdariaArena", direction: .outboundTrigger),
            SectorPortal(x: 1056, y: 208, width: 160, height: 96, targetSectorName: "EdariaArena", direction: .arrivalPlacement)
        ])
    }

    @Test func `edaria arena golden`() throws {
        let sector = try MapCodec.read(MapFixtures.data(.edariaArena))
        #expect(sector.version == 5)
        #expect(sector.dimensions == GridSize(width: 4, height: 4))
        #expect(sector.ground == GroundTile(tilesetIndex: 25, sourceX: 0, sourceY: 0))
        #expect(sector.light == LightSetting(indoor: true, brightness: 75))
        #expect(sector.objects.count == 1)
        #expect(sector.collisionMasks.count == 2)
        #expect(sector.npcs.isEmpty)
        #expect(sector.portals == [
            SectorPortal(x: 166, y: 494, width: 180, height: 18, targetSectorName: "EdariaMitte", direction: .outboundTrigger),
            SectorPortal(x: 176, y: 384, width: 160, height: 96, targetSectorName: "EdariaMitte", direction: .arrivalPlacement)
        ])
        #expect(sector.monsterSpawns.count == 1)
        let gespenst = try #require(sector.monsterSpawns.first)
        #expect(gespenst.name == "Gespenst")
        #expect(gespenst.spawnOrigin == GridPoint(x: 64, y: 64))
        #expect(gespenst.spawnHP == 100)
        #expect(gespenst.spawnBalance == 100)
        #expect(gespenst.spawnMana == 100)
    }

    @Test func `edaria bibliothek golden`() throws {
        let sector = try MapCodec.read(MapFixtures.data(.edariaBibliothek))
        #expect(sector.version == 10)
        #expect(sector.dimensions == GridSize(width: 4, height: 4))
        #expect(sector.ground == GroundTile(tilesetIndex: 25, sourceX: 64, sourceY: 0))
        #expect(sector.light == LightSetting(indoor: true, brightness: 100))
        #expect(sector.objects.count == 33)
        #expect(sector.collisionMasks.count == 21)
        #expect(sector.monsterSpawns.isEmpty)
        #expect(sector.npcs.count == 1)
        let libus = try #require(sector.npcs.first)
        #expect(libus.name == "Libus")
        #expect(Direction(legacyRichtung: libus.direction) == .west)
        #expect(libus.dialogScript.contains("$name"))
        // spawnOrigin is the authored top-left, stored verbatim; centering lives in NPCPlacement.
        #expect(libus.spawnOrigin == GridPoint(x: 352, y: 384))
        #expect(sector.portals == [
            SectorPortal(x: 0, y: 32, width: 256, height: 288, targetSectorName: "EdariaBibliothek", direction: .arrivalPlacement),
            SectorPortal(x: 54, y: 494, width: 180, height: 18, targetSectorName: "EdariaMitte", direction: .outboundTrigger),
            SectorPortal(x: 64, y: 384, width: 160, height: 96, targetSectorName: "EdariaMitte", direction: .arrivalPlacement)
        ])
        // Representative raw geometry on the richest fixture: a count-preserving coordinate change
        // would pass the count assertions but fail these.
        #expect(sector.collisionMasks[0] == CollisionMask(x: 0, y: 0, width: 256, height: 22))
        #expect(sector.objects[0] == Object(x: 0, y: -48, tilesetIndex: 25, sourceX: 64, sourceY: 512,
                                            sourceWidth: 64, sourceHeight: 96, priority: 0))
    }
}
