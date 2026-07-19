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

    @Test func `an oversized file is rejected before decoding`() {
        // The size preflight must fire before `JSONDecoder` parses anything — the payload
        // here is not even JSON, so reaching the parser would throw a different error shape
        // only after chewing through the whole blob.
        let oversized = Data(count: SomnioConstants.maxSectorFileBytes + 1)
        #expect(throws: DecodingError.self) { try MapCodec.read(oversized) }
    }

    @Test func `missing required field throws`() {
        // An object missing every `SectorBody` key; `version` is the first required field.
        let bytes = Data("{}".utf8)
        #expect(throws: DecodingError.self) { try MapCodec.read(bytes) }
    }

    @Test func `a legacy source-rect-shaped file fails loudly`() {
        // New-shape-only policy: the pre-3D format carried `ground` tileset crops instead of
        // `floorMaterialID`/`modelID`. There is no auto-upgrade path — a legacy file throws a
        // `DecodingError` for the absent id fields rather than silently loading.
        let json = """
        {
          "version": 1,
          "dimensions": {"width": 4, "height": 4},
          "ground": {"tilesetIndex": 25, "sourceX": 0, "sourceY": 0},
          "light": {"indoor": false, "brightness": 100},
          "objects": [
            {"x": 0, "y": 0, "tilesetIndex": 25, "sourceX": 64, "sourceY": 512, "sourceWidth": 64, "sourceHeight": 96, "priority": 0}
          ],
          "collisionMasks": [],
          "portals": [],
          "npcs": [],
          "monsterSpawns": []
        }
        """
        #expect(throws: DecodingError.self) { try MapCodec.read(Data(json.utf8)) }
    }

    @Test func `unknown NPC direction string throws`() {
        // `direction` outside the four semantic cases (north/east/south/west) is a corruption
        // signal — `NPC`'s hand-written decode rejects it rather than coercing to a default.
        let json = """
        {
          "version": 1,
          "dimensions": {"width": 4, "height": 4},
          "floorMaterialID": "grass-meadow",
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
          "floorMaterialID": "grass-meadow",
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
          "floorMaterialID": "grass-meadow",
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
          "floorMaterialID": "grass-meadow",
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

    @Test func `out-of-range NPC direction normalizes on read`() throws {
        // Heading normalization is the validation: a persisted out-of-range degree value wraps
        // into [0, 360) instead of failing the whole sector file.
        let json = """
        {
          "version": 1,
          "dimensions": {"width": 4, "height": 4},
          "floorMaterialID": "grass-meadow",
          "light": {"indoor": false, "brightness": 0},
          "objects": [],
          "collisionMasks": [],
          "portals": [],
          "npcs": [{
            "spawnOrigin": {"x": 0, "y": 0},
            "spawnBoxSize": {"width": 1, "height": 1},
            "maskSize": {"width": 1, "height": 1},
            "name": "X", "figure": 0, "direction": -90, "behaviorTag": 0,
            "dialogScript": ""
          }],
          "monsterSpawns": []
        }
        """
        let body = try MapCodec.read(Data(json.utf8))
        #expect(body.npcs.first?.facing == Heading(cardinal: .west))
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
            floorMaterialID: "grass-meadow",
            light: LightSetting(indoor: false, brightness: 0)
        )
        #expect(throws: EncodingError.self) { try MapCodec.write(body) }
    }

    @Test(arguments: [
        (SomnioConstants.maxSectorObjects + 1, 0),
        (0, SomnioConstants.maxSectorCollisionMasks + 1)
    ])
    func `over-cap content counts throw on read and at-cap counts decode`(objectCount: Int, maskCount: Int) throws {
        // The renderer's bottom-edge anchor scan is O(objects × collisionMasks), so a hostile
        // file can't smuggle counts a frame-sized payload would otherwise carry; the exact caps
        // still decode, guarding against a `<` vs `<=` off-by-one.
        #expect(throws: DecodingError.self) {
            try MapCodec.read(Self.contentCountJSON(objectCount: objectCount, maskCount: maskCount))
        }
        let atCap = try MapCodec.read(Self.contentCountJSON(
            objectCount: min(objectCount, SomnioConstants.maxSectorObjects),
            maskCount: min(maskCount, SomnioConstants.maxSectorCollisionMasks)
        ))
        #expect(atCap.hasContentCountsWithinBounds)
    }

    @Test func `at-cap portal, npc, monster-spawn, and floor-patch counts decode`() throws {
        // The exact caps still decode, guarding each new `<=` against an off-by-one.
        let atCap = try MapCodec.read(Self.contentCountJSON(
            portalCount: SomnioConstants.maxSectorPortals,
            npcCount: SomnioConstants.maxSectorNPCs,
            monsterSpawnCount: SomnioConstants.maxSectorMonsterSpawns,
            floorPatchCount: SomnioConstants.maxSectorFloorPatches
        ))
        #expect(atCap.hasContentCountsWithinBounds)
    }

    @Test(arguments: [
        (SomnioConstants.maxSectorPortals + 1, 0, 0, 0),
        (0, SomnioConstants.maxSectorNPCs + 1, 0, 0),
        (0, 0, SomnioConstants.maxSectorMonsterSpawns + 1, 0),
        (0, 0, 0, SomnioConstants.maxSectorFloorPatches + 1)
    ])
    func `over-cap portal, npc, monster-spawn, and floor-patch counts throw on read`(
        portalCount: Int, npcCount: Int, monsterSpawnCount: Int, floorPatchCount: Int
    ) {
        // Portals, NPCs, monster spawns, and floor patches each drive per-record work on
        // load (overlay rects, spawn/dialog runtimes, patch meshes), so a hostile file
        // can't smuggle unbounded arrays through the two seams the codec shares with the
        // wire boundary.
        #expect(throws: DecodingError.self) {
            try MapCodec.read(Self.contentCountJSON(
                portalCount: portalCount, npcCount: npcCount,
                monsterSpawnCount: monsterSpawnCount, floorPatchCount: floorPatchCount
            ))
        }
    }

    @Test func `over-cap content counts throw on write`() {
        // The writer gates on the same count caps as the reader so it can't persist a file
        // `read` would refuse.
        let body = SectorBody(
            version: 1,
            dimensions: GridSize(width: 4, height: 4),
            floorMaterialID: "grass-meadow",
            light: LightSetting(indoor: false, brightness: 0),
            collisionMasks: Array(
                repeating: CollisionMask(x: 0, y: 0, width: 1, height: 1),
                count: SomnioConstants.maxSectorCollisionMasks + 1
            )
        )
        #expect(throws: EncodingError.self) { try MapCodec.write(body) }
    }

    @Test func `over-cap floor-patch counts throw on write`() {
        let body = SectorBody(
            version: 1,
            dimensions: GridSize(width: 4, height: 4),
            floorMaterialID: "grass-meadow",
            light: LightSetting(indoor: false, brightness: 0),
            floorPatches: Array(
                repeating: FloorPatch(floorMaterialID: "cobble-town", x: 0, y: 0, width: 1, height: 1),
                count: SomnioConstants.maxSectorFloorPatches + 1
            )
        )
        #expect(throws: EncodingError.self) { try MapCodec.write(body) }
    }

    /// A minimal sector JSON carrying repeated copies of one record per array, assembled
    /// textually so the over-cap cases can't be blocked by the writer.
    private static func contentCountJSON(
        objectCount: Int = 0,
        maskCount: Int = 0,
        portalCount: Int = 0,
        npcCount: Int = 0,
        monsterSpawnCount: Int = 0,
        floorPatchCount: Int = 0
    ) -> Data {
        let object = """
        {"x": 0, "y": 0, "modelID": "door", "sourceWidth": 1, "sourceHeight": 1, "priority": 0}
        """
        let mask = """
        {"x": 0, "y": 0, "width": 1, "height": 1}
        """
        let portal = """
        {"x": 0, "y": 0, "width": 1, "height": 1, "targetSectorName": "Other", "direction": 1}
        """
        let npc = """
        {"spawnOrigin": {"x": 0, "y": 0}, "spawnBoxSize": {"width": 1, "height": 1}, \
        "maskSize": {"width": 1, "height": 1}, "name": "Libus", "figure": 16, "direction": 0, \
        "behaviorTag": 0, "dialogScript": ""}
        """
        let monsterSpawn = """
        {"spawnOrigin": {"x": 0, "y": 0}, "spawnBoxSize": {"width": 1, "height": 1}, \
        "spawnedMonsterSize": {"width": 1, "height": 1}, "name": "Gespenst", "figure": 0, \
        "bounded": false, "spawnHP": 100, "spawnBalance": 100, "spawnMana": 100, "aiScriptIndex": 0}
        """
        let floorPatch = """
        {"floorMaterialID": "cobble-town", "x": 0, "y": 0, "width": 1, "height": 1}
        """
        let json = """
        {
          "version": 1,
          "dimensions": {"width": 4, "height": 4},
          "floorMaterialID": "grass-meadow",
          "light": {"indoor": false, "brightness": 0},
          "objects": [\(Array(repeating: object, count: objectCount).joined(separator: ","))],
          "collisionMasks": [\(Array(repeating: mask, count: maskCount).joined(separator: ","))],
          "portals": [\(Array(repeating: portal, count: portalCount).joined(separator: ","))],
          "npcs": [\(Array(repeating: npc, count: npcCount).joined(separator: ","))],
          "monsterSpawns": [\(Array(repeating: monsterSpawn, count: monsterSpawnCount).joined(separator: ","))],
          "floorPatches": [\(Array(repeating: floorPatch, count: floorPatchCount).joined(separator: ","))]
        }
        """
        return Data(json.utf8)
    }
}
