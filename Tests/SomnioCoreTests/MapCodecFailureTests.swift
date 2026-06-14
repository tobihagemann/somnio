import Foundation
import Testing
@testable import SomnioCore

// Negative-input tests for the JSON `MapCodec`. The codec parses untrusted JSON on the editor
// and server load paths, so each decode/encode-failure mode it relies on should have a
// regression guard.

struct MapCodecFailureTests {
    @Test func `malformed JSON throws`() {
        let bytes = Data("{".utf8)
        #expect(throws: (any Error).self) { try MapCodec.read(bytes) }
    }

    @Test func `missing required field throws`() {
        // An object missing every `SectorBody` key; `version` is the first required field.
        let bytes = Data("{}".utf8)
        #expect(throws: DecodingError.self) { try MapCodec.read(bytes) }
    }

    @Test func `unknown NPC direction string throws`() {
        // `direction` outside the four semantic cases (north/east/south/west) is a corruption
        // signal — `NPC`'s hand-written decode rejects it rather than coercing to a default.
        let json = """
        {
          "version": 1,
          "dimensions": {"width": 4, "height": 4},
          "ground": {"tilesetIndex": 0, "sourceX": 0, "sourceY": 0},
          "light": {"indoor": false, "brightness": 100},
          "objects": [],
          "collisionMasks": [],
          "portals": [],
          "npcs": [
            {
              "spawnOrigin": {"x": 1, "y": 1},
              "spawnBoxSize": {"width": 1, "height": 1},
              "maskSize": {"width": 1, "height": 1},
              "name": "Libus",
              "figure": 16,
              "direction": "up",
              "behaviorTag": 0,
              "dialogScript": "Hi $name."
            }
          ],
          "monsterSpawns": []
        }
        """
        #expect(throws: DecodingError.self) { try MapCodec.read(Data(json.utf8)) }
    }

    @Test func `unknown portal direction value throws`() {
        // `PortalDirection` is a closed enum (0 = outboundTrigger, 1 = arrivalPlacement); a value
        // outside that set fails the synthesized `Codable` decode rather than loading a bad portal.
        let json = """
        {
          "version": 1,
          "dimensions": {"width": 4, "height": 4},
          "ground": {"tilesetIndex": 0, "sourceX": 0, "sourceY": 0},
          "light": {"indoor": false, "brightness": 100},
          "objects": [],
          "collisionMasks": [],
          "portals": [
            {"x": 0, "y": 0, "width": 1, "height": 1, "targetSectorName": "Other", "direction": 99}
          ],
          "npcs": [],
          "monsterSpawns": []
        }
        """
        #expect(throws: DecodingError.self) { try MapCodec.read(Data(json.utf8)) }
    }

    /// Each branch of the dimension bound: non-positive axes, per-axis cap (maxSectorDimension =
    /// 1024), and the area cap (maxSectorArea = 65536) tripped on its own with both axes in range.
    @Test(arguments: [
        (Int16(0), Int16(4)), // zero width
        (Int16(4), Int16(0)), // zero height
        (Int16(-1), Int16(4)), // negative width
        (Int16(2000), Int16(4)), // width over per-axis cap
        (Int16(4), Int16(2000)), // height over per-axis cap
        (Int16(512), Int16(512)) // area over cap (262144), both axes within per-axis cap
    ])
    func `out-of-range sector dimensions throw on read`(width: Int16, height: Int16) {
        // The disk-load path bounds dimensions like the wire boundary so a hostile file can't
        // drive an unbounded tile-map allocation.
        let json = """
        {
          "version": 1,
          "dimensions": {"width": \(width), "height": \(height)},
          "ground": {"tilesetIndex": 0, "sourceX": 0, "sourceY": 0},
          "light": {"indoor": false, "brightness": 0},
          "objects": [],
          "collisionMasks": [],
          "portals": [],
          "npcs": [],
          "monsterSpawns": []
        }
        """
        #expect(throws: DecodingError.self) { try MapCodec.read(Data(json.utf8)) }
    }

    @Test func `at-cap sector dimensions decode`() throws {
        // Inclusive boundary: 1024 = maxSectorDimension per axis and 1024 x 64 = 65536 =
        // maxSectorArea both pass, guarding the bound against a `<` vs `<=` off-by-one.
        let json = """
        {
          "version": 1,
          "dimensions": {"width": 1024, "height": 64},
          "ground": {"tilesetIndex": 0, "sourceX": 0, "sourceY": 0},
          "light": {"indoor": false, "brightness": 0},
          "objects": [],
          "collisionMasks": [],
          "portals": [],
          "npcs": [],
          "monsterSpawns": []
        }
        """
        let body = try MapCodec.read(Data(json.utf8))
        #expect(body.dimensions == GridSize(width: 1024, height: 64))
    }

    @Test func `out-of-range NPC direction throws on encode`() {
        // The stored `direction` int must be a valid legacy richtung (0-3); the editor constrains
        // authored values, so an out-of-range field is corruption and fails closed on write.
        let body = SectorBody(
            version: 1,
            dimensions: GridSize(width: 4, height: 4),
            ground: GroundTile(tilesetIndex: 0, sourceX: 0, sourceY: 0),
            light: LightSetting(indoor: false, brightness: 0),
            npcs: [NPC(spawnOrigin: GridPoint(x: 0, y: 0),
                       spawnBoxSize: GridSize(width: 1, height: 1),
                       maskSize: GridSize(width: 1, height: 1),
                       name: "X", figure: 0, direction: 7, behaviorTag: 0,
                       dialogScript: "")]
        )
        #expect(throws: EncodingError.self) { try MapCodec.write(body) }
    }

    @Test(arguments: [
        (Int16(0), Int16(4)), // zero width
        (Int16(2000), Int16(4)), // width over per-axis cap
        (Int16(512), Int16(512)) // area over cap, both axes within per-axis cap
    ])
    func `out-of-range sector dimensions throw on write`(width: Int16, height: Int16) {
        // The writer gates on the same bound as the reader so it can't persist a file `read`
        // would refuse; out-of-range dimensions fail closed as an EncodingError.
        let body = SectorBody(
            version: 1,
            dimensions: GridSize(width: width, height: height),
            ground: GroundTile(tilesetIndex: 0, sourceX: 0, sourceY: 0),
            light: LightSetting(indoor: false, brightness: 0)
        )
        #expect(throws: EncodingError.self) { try MapCodec.write(body) }
    }
}
