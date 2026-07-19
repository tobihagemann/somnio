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

    @Test(arguments: MapFixtures.Name.allCases)
    func `defaulted rotation and floorPatches keys stay omitted on encode`(_ name: MapFixtures.Name) throws {
        // The hand-written encoders' whole purpose is byte stability: a semantic round-trip
        // still passes if they regress to emitting `"rotation" : 0` or `"floorPatches" : []`,
        // so pin the key absence in the raw JSON.
        let decoded = try MapCodec.read(MapFixtures.data(name))
        let written = try String(decoding: MapCodec.write(decoded), as: UTF8.self)
        let expectedRotationKeys = decoded.objects.filter { $0.rotation != 0 }.count
        #expect(written.components(separatedBy: "\"rotation\"").count - 1 == expectedRotationKeys)
        #expect(written.contains("\"floorPatches\"") == !decoded.floorPatches.isEmpty)
    }

    @Test func `edaria mitte golden`() throws {
        let sector = try MapCodec.read(MapFixtures.data(.edariaMitte))
        #expect(sector.version == 10)
        #expect(sector.dimensions == GridSize(width: 16, height: 16))
        // Grass square, cobbled streets: the base floor is meadow grass and the street
        // cross (the full north-south strip plus the two east-west arms, split so no two
        // coplanar patches overlap and z-fight) is paved via floor patches.
        #expect(sector.floorMaterialID == "grass-meadow")
        #expect(sector.floorPatches == [
            FloorPatch(floorMaterialID: "cobble-town", x: 800, y: 0, width: 448, height: 2048),
            FloorPatch(floorMaterialID: "cobble-town", x: 0, y: 800, width: 800, height: 448),
            FloorPatch(floorMaterialID: "cobble-town", x: 1248, y: 800, width: 800, height: 448)
        ])
        #expect(sector.light == LightSetting(indoor: false, brightness: 100))
        // The walled square after the reference: perimeter + courtyard walls with
        // centered entrance gaps, the four enterable buildings plus the sealed
        // Kaempfer hall inside the yards (each mesh carries its own door), the
        // central well, and the yard pines.
        #expect(sector.objects.count == 92)
        #expect(sector.collisionMasks.count == 108)
        // Wall collision is mesh-flush: every straight wall's mask is its decal, every
        // corner contributes its two 32px arms, so only the building masses run deeper
        // than a footprint strip. Fat perimeter bands would block walkable-looking ground.
        #expect(sector.collisionMasks.filter { min($0.width, $0.height) > 56 }.count == 5)
        for wall in sector.objects where wall.modelID == "stone-wall" {
            let flush = CollisionMask(x: wall.x, y: wall.y, width: wall.sourceWidth, height: wall.sourceHeight)
            #expect(sector.collisionMasks.contains(flush))
        }
        // One straight stem plus KayKit's corner piece at every joint, oriented per
        // placement: the north-south runs carry rotation 90.
        #expect(sector.objects.filter { $0.modelID == "stone-wall" }.count == 64)
        #expect(sector.objects.filter { $0.modelID == "stone-wall" && $0.rotation == 90 }.count == 32)
        #expect(sector.objects.filter { $0.modelID == "stone-wall-corner" }.count == 16)
        #expect(sector.objects.filter { $0.modelID.hasPrefix("building-") }.count == 5)
        // Door yaw is placement data: the shop house faces south, the arena house east.
        #expect(sector.objects.contains { $0.modelID == "building-house" && $0.rotation == 270 })
        #expect(sector.objects.contains { $0.modelID == "building-house" && $0.rotation == 0 })
        #expect(sector.objects.contains { $0.modelID == "well" })
        #expect(sector.objects.filter { $0.modelID == "pine-tree" }.count == 6)
        #expect(sector.monsterSpawns.isEmpty)
        #expect(sector.npcs.count == 1)
        let meister = try #require(sector.npcs.first)
        #expect(meister.name == "Pugnax")
        #expect(meister.figure == 18)
        #expect(meister.facing == Heading(cardinal: .south))
        #expect(meister.dialogScript.contains("$name"))
        // Full portal records — routing and placement geometry counts alone can't protect.
        #expect(sector.portals == [
            SectorPortal(x: 800, y: 0, width: 448, height: 16, targetSectorName: "Nordwiese", direction: .outboundTrigger),
            SectorPortal(x: 944, y: 160, width: 160, height: 96, targetSectorName: "Nordwiese", direction: .arrivalPlacement),
            SectorPortal(x: 1808, y: 420, width: 64, height: 24, targetSectorName: "EdariaBibliothek", direction: .outboundTrigger),
            SectorPortal(x: 1760, y: 464, width: 160, height: 96, targetSectorName: "EdariaBibliothek", direction: .arrivalPlacement),
            SectorPortal(x: 1536, y: 1882, width: 24, height: 64, targetSectorName: "EdariaArena", direction: .outboundTrigger),
            SectorPortal(x: 1568, y: 1862, width: 160, height: 96, targetSectorName: "EdariaArena", direction: .arrivalPlacement),
            SectorPortal(x: 1350, y: 292, width: 64, height: 24, targetSectorName: "EdariaShop", direction: .outboundTrigger),
            SectorPortal(x: 1302, y: 332, width: 160, height: 96, targetSectorName: "EdariaShop", direction: .arrivalPlacement),
            SectorPortal(x: 352, y: 140, width: 24, height: 64, targetSectorName: "EdariaInn", direction: .outboundTrigger),
            SectorPortal(x: 384, y: 156, width: 160, height: 96, targetSectorName: "EdariaInn", direction: .arrivalPlacement)
        ])
    }

    @Test func `nordwiese golden`() throws {
        let sector = try MapCodec.read(MapFixtures.data(.nordwiese))
        #expect(sector.version == 1)
        #expect(sector.dimensions == GridSize(width: 12, height: 12))
        #expect(sector.floorMaterialID == "grass-meadow")
        #expect(sector.light == LightSetting(indoor: false, brightness: 100))
        // Six fringe pines plus EdariaMitte's town wall along the south border: two
        // four-segment stone runs flanking the gate opening, with a tile-deep cobble
        // street patch leading through it.
        #expect(sector.objects.count == 14)
        #expect(sector.collisionMasks.count == 14)
        #expect(sector.objects.filter { $0.modelID == "stone-wall" }.count == 8)
        #expect(sector.floorPatches == [
            FloorPatch(floorMaterialID: "cobble-town", x: 512, y: 1408, width: 512, height: 128)
        ])
        #expect(sector.npcs.isEmpty)
        // Canon: the near meadow's nightmares are faint, almost harmless — none spawn here.
        #expect(sector.monsterSpawns.isEmpty)
        #expect(sector.portals == [
            SectorPortal(x: 512, y: 1520, width: 512, height: 16, targetSectorName: "EdariaMitte", direction: .outboundTrigger),
            SectorPortal(x: 688, y: 1360, width: 160, height: 96, targetSectorName: "EdariaMitte", direction: .arrivalPlacement),
            SectorPortal(x: 640, y: 0, width: 256, height: 16, targetSectorName: "Nordwald", direction: .outboundTrigger),
            SectorPortal(x: 688, y: 80, width: 160, height: 96, targetSectorName: "Nordwald", direction: .arrivalPlacement)
        ])
    }

    @Test func `nordwald golden`() throws {
        let sector = try MapCodec.read(MapFixtures.data(.nordwald))
        #expect(sector.version == 1)
        #expect(sector.dimensions == GridSize(width: 12, height: 12))
        #expect(sector.floorMaterialID == "forest-floor")
        #expect(sector.light == LightSetting(indoor: false, brightness: 70))
        // The forest reads through its pines: every object is a pine-tree with a trunk mask.
        #expect(sector.objects.count == 32)
        #expect(sector.objects.allSatisfy { $0.modelID == "pine-tree" })
        #expect(sector.collisionMasks.count == 32)
        #expect(sector.npcs.isEmpty)
        #expect(sector.portals == [
            SectorPortal(x: 640, y: 1520, width: 256, height: 16, targetSectorName: "Nordwiese", direction: .outboundTrigger),
            SectorPortal(x: 688, y: 1360, width: 160, height: 96, targetSectorName: "Nordwiese", direction: .arrivalPlacement)
        ])
        #expect(sector.monsterSpawns.count == 1)
        let gespenst = try #require(sector.monsterSpawns.first)
        #expect(gespenst.name == "Gespenst")
        #expect(gespenst.figure == 0)
        #expect(gespenst.aiScriptIndex == 0)
        #expect(gespenst.spawnOrigin == GridPoint(x: 448, y: 384))
        #expect(gespenst.spawnBoxSize == GridSize(width: 640, height: 384))
        #expect(gespenst.spawnHP == 100)
        #expect(gespenst.spawnBalance == 100)
        #expect(gespenst.spawnMana == 100)
    }

    @Test func `edaria shop golden`() throws {
        let sector = try MapCodec.read(MapFixtures.data(.edariaShop))
        #expect(sector.version == 1)
        // A compact 2x2 Kramladen, designed outside-in: every wall lined (goods-shelf
        // wall north, shelf aisle west, storeroom east), the counter row in front of
        // the shelves with der Kraemer boxed in behind it, and one clear browsing
        // floor between door and counter. Solid furniture masks are mesh-flush
        // (= the decal); rug and candle stay walkable.
        #expect(sector.dimensions == GridSize(width: 2, height: 2))
        #expect(sector.floorMaterialID == "wood-warm")
        #expect(sector.light == LightSetting(indoor: true, brightness: 100))
        #expect(sector.objects.count == 22)
        #expect(sector.collisionMasks.count == 22)
        #expect(sector.objects.filter { $0.modelID == "counter" }.count == 3)
        #expect(sector.objects.filter { $0.modelID == "goods-shelf" }.count == 7)
        #expect(sector.objects.contains { $0.modelID == "crate-stack" })
        #expect(sector.objects.contains { $0.modelID == "rug" })
        #expect(sector.monsterSpawns.isEmpty)
        #expect(sector.npcs.count == 1)
        let kraemer = try #require(sector.npcs.first)
        #expect(kraemer.name == "Mercus")
        #expect(kraemer.figure == 17)
        #expect(kraemer.facing == Heading(cardinal: .south))
        #expect(kraemer.dialogScript.contains("$name"))
        #expect(sector.portals == [
            SectorPortal(x: 86, y: 238, width: 84, height: 18, targetSectorName: "EdariaMitte", direction: .outboundTrigger),
            SectorPortal(x: 72, y: 148, width: 112, height: 72, targetSectorName: "EdariaMitte", direction: .arrivalPlacement)
        ])
    }

    @Test func `edaria inn golden`() throws {
        let sector = try MapCodec.read(MapFixtures.data(.edariaInn))
        #expect(sector.version == 1)
        // A compact 2x2 Gaststube, designed outside-in: the bar parallel to the west
        // wall with die Wirtin boxed in behind it (bottle shelf, barrels, keg at her
        // back), the wake-point beds in the north-east nook with their trunk, the
        // round table against the bar's south end, and the east-wall door opening
        // onto the one clear path to the bar.
        #expect(sector.dimensions == GridSize(width: 2, height: 2))
        #expect(sector.floorMaterialID == "wood-warm")
        #expect(sector.light == LightSetting(indoor: true, brightness: 100))
        #expect(sector.objects.count == 18)
        #expect(sector.collisionMasks.count == 17)
        #expect(sector.objects.filter { $0.modelID == "counter" && $0.rotation == 90 }.count == 2)
        // Heads to the north wall, feet into the room.
        #expect(sector.objects.filter { $0.modelID == "bed" && $0.rotation == 270 }.count == 2)
        #expect(sector.objects.filter { $0.modelID == "stool" }.count == 3)
        #expect(sector.objects.contains { $0.modelID == "keg" })
        #expect(sector.monsterSpawns.isEmpty)
        #expect(sector.npcs.count == 1)
        let wirtin = try #require(sector.npcs.first)
        #expect(wirtin.name == "Quieta")
        // Die Wirtin re-skins the Kraemer stem — a deliberate figure reuse, not a typo.
        #expect(wirtin.figure == 17)
        // She keeps her bar on the west wall, facing her guests to the east.
        #expect(wirtin.facing == Heading(cardinal: .east))
        #expect(wirtin.dialogScript.contains("$name"))
        // East-wall exit: the tavern building is entered through its east door, so the
        // interior door pair sits on the east wall.
        #expect(sector.portals == [
            SectorPortal(x: 238, y: 86, width: 18, height: 84, targetSectorName: "EdariaMitte", direction: .outboundTrigger),
            SectorPortal(x: 144, y: 96, width: 72, height: 80, targetSectorName: "EdariaMitte", direction: .arrivalPlacement)
        ])
    }

    @Test func `edaria arena golden`() throws {
        let sector = try MapCodec.read(MapFixtures.data(.edariaArena))
        #expect(sector.version == 7)
        #expect(sector.dimensions == GridSize(width: 4, height: 4))
        #expect(sector.floorMaterialID == "stone-arena")
        #expect(sector.light == LightSetting(indoor: true, brightness: 75))
        #expect(sector.objects.count == 1)
        #expect(sector.collisionMasks.count == 2)
        #expect(sector.npcs.isEmpty)
        // East-wall exit: the arena building is entered through its east door, so the
        // interior door pair sits on the east wall.
        #expect(sector.portals == [
            SectorPortal(x: 494, y: 166, width: 18, height: 180, targetSectorName: "EdariaMitte", direction: .outboundTrigger),
            SectorPortal(x: 384, y: 176, width: 96, height: 160, targetSectorName: "EdariaMitte", direction: .arrivalPlacement)
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
        #expect(sector.version == 11)
        #expect(sector.dimensions == GridSize(width: 4, height: 4))
        #expect(sector.floorMaterialID == "wood-warm")
        #expect(sector.light == LightSetting(indoor: true, brightness: 100))
        #expect(sector.objects.count == 33)
        #expect(sector.collisionMasks.count == 21)
        #expect(sector.monsterSpawns.isEmpty)
        #expect(sector.npcs.count == 1)
        let libus = try #require(sector.npcs.first)
        #expect(libus.name == "Libus")
        #expect(libus.facing == Heading(cardinal: .west))
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
        #expect(sector.objects[0] == Object(x: 0, y: -48, modelID: "bookshelf-ornate",
                                            sourceWidth: 64, sourceHeight: 96, priority: 0))
    }
}
