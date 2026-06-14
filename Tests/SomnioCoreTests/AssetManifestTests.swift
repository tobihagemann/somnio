import Foundation
import SomnioCore
import Testing

// The asset manifest drives all of `BundleMainSpriteAssets`'s texture resolution, so each
// decode/validation mode and rule helper it relies on has a regression guard here.

struct AssetManifestTests {
    @Test func `bundledLegacy decodes the committed manifest`() throws {
        let manifest = try AssetManifestCodec.bundledLegacy()
        #expect(manifest == AssetManifest.legacyFallback)
    }

    @Test func `a valid manifest round-trips through write and read`() throws {
        let data = try AssetManifestCodec.write(AssetManifest.legacyFallback)
        let decoded = try AssetManifestCodec.read(data)
        #expect(decoded == AssetManifest.legacyFallback)
    }

    @Test func `directionRows serializes as semantic case names not rawValues`() throws {
        let data = try AssetManifestCodec.write(AssetManifest.legacyFallback)
        let json = try #require(String(data: data, encoding: .utf8))
        for name in ["south", "west", "east", "north"] {
            #expect(json.contains("\"\(name)\""))
        }
    }

    // Validation rejections are driven through `read(Data:)` — the production protection path
    // (`AssetManifestCodec.bundledLegacy` → `read`) — rather than `write`, so the JSON a corrupt
    // manifest file would carry is what the validator actually sees.

    @Test func `read rejects directionRows missing a direction`() {
        #expect(throws: DecodingError.self) {
            try AssetManifestCodec.read(manifestJSON(directionRows: #"["south", "west", "east"]"#))
        }
    }

    @Test func `read rejects directionRows with a duplicate`() {
        #expect(throws: DecodingError.self) {
            try AssetManifestCodec.read(manifestJSON(directionRows: #"["south", "south", "east", "north"]"#))
        }
    }

    @Test func `read rejects an unknown direction name`() {
        #expect(throws: DecodingError.self) {
            try AssetManifestCodec.read(manifestJSON(directionRows: #"["up", "west", "east", "north"]"#))
        }
    }

    @Test func `read rejects a non-positive entityFrameCount`() {
        #expect(throws: DecodingError.self) {
            try AssetManifestCodec.read(manifestJSON(entityFrameCount: "0"))
        }
    }

    @Test func `read rejects a player band missing its grid and cell`() {
        #expect(throws: DecodingError.self) {
            try AssetManifestCodec.read(manifestJSON(player: #"{"leadingNumberRanges": [{"lower": 1, "upper": 1}]}"#))
        }
    }

    @Test func `read rejects a player band with a non-positive sheetGrid`() {
        let player = #"{"leadingNumberRanges": [{"lower": 1, "upper": 1}], "sheetGrid": {"columns": 0, "rows": 2}, "cell": {"width": 32, "height": 48}}"#
        #expect(throws: DecodingError.self) {
            try AssetManifestCodec.read(manifestJSON(player: player))
        }
    }

    @Test func `read rejects a player band with a non-positive cell`() {
        let player = #"{"leadingNumberRanges": [{"lower": 1, "upper": 1}], "sheetGrid": {"columns": 8, "rows": 2}, "cell": {"width": 0, "height": 48}}"#
        #expect(throws: DecodingError.self) {
            try AssetManifestCodec.read(manifestJSON(player: player))
        }
    }

    @Test func `read rejects a single-region band carrying a grid`() {
        let npc = #"{"leadingNumberRanges": [{"lower": 2, "upper": 10}], "sheetGrid": {"columns": 1, "rows": 1}}"#
        #expect(throws: DecodingError.self) {
            try AssetManifestCodec.read(manifestJSON(npc: npc))
        }
    }

    @Test func `read rejects a single-region band carrying a cell`() {
        let npc = #"{"leadingNumberRanges": [{"lower": 2, "upper": 10}], "cell": {"width": 32, "height": 48}}"#
        #expect(throws: DecodingError.self) {
            try AssetManifestCodec.read(manifestJSON(npc: npc))
        }
    }

    @Test func `read rejects an inverted band range`() {
        #expect(throws: DecodingError.self) {
            try AssetManifestCodec.read(manifestJSON(npc: #"{"leadingNumberRanges": [{"lower": 10, "upper": 2}]}"#))
        }
    }

    @Test func `write throws EncodingError on an invalid manifest`() {
        // Encode-time model corruption surfaces as EncodingError (mirroring MapCodec.write /
        // NPC.encode), distinct from read's DecodingError.
        let manifest = AssetManifest(
            directionRows: [.south, .west, .east],
            entityFrameCount: 4,
            tilesets: TilesetRule(filenameFormat: "%03d-", indexOffset: 1),
            characterBands: AssetManifest.legacyFallback.characterBands
        )
        #expect(throws: EncodingError.self) { try AssetManifestCodec.write(manifest) }
    }

    @Test func `tilesetFilenamePrefix applies the legacy 1-based offset`() {
        let manifest = AssetManifest.legacyFallback
        #expect(manifest.tilesetFilenamePrefix(forIndex: 0) == "001-")
        #expect(manifest.tilesetFilenamePrefix(forIndex: 5) == "006-")
    }

    @Test(arguments: [
        (1, CharacterBand.player),
        (3, CharacterBand.npc),
        (68, CharacterBand.npc),
        (11, CharacterBand.monster),
        (60, CharacterBand.monster)
    ])
    func `band maps a leading number to its legacy band`(number: Int, band: CharacterBand) {
        #expect(AssetManifest.legacyFallback.band(forLeadingNumber: number) == band)
    }

    @Test func `band returns nil for an unclaimed leading number`() {
        #expect(AssetManifest.legacyFallback.band(forLeadingNumber: 200) == nil)
    }

    @Test(arguments: [
        (Direction.south, 0),
        (Direction.west, 1),
        (Direction.east, 2),
        (Direction.north, 3)
    ])
    func `rowIndex follows the legacy S-W-E-N row order`(facing: Direction, row: Int) {
        #expect(AssetManifest.legacyFallback.rowIndex(for: facing) == row)
    }

    // MARK: - Helpers

    /// Builds manifest JSON from the legacy defaults, overriding one fragment per test so each
    /// rejection case feeds the validator exactly the JSON a corrupt manifest file would carry.
    private func manifestJSON(
        directionRows: String = #"["south", "west", "east", "north"]"#,
        entityFrameCount: String = "4",
        player: String = #"{"leadingNumberRanges": [{"lower": 1, "upper": 1}], "sheetGrid": {"columns": 8, "rows": 2}, "cell": {"width": 32, "height": 48}}"#,
        npc: String = #"{"leadingNumberRanges": [{"lower": 2, "upper": 10}, {"lower": 61, "upper": 109}]}"#,
        monster: String = #"{"leadingNumberRanges": [{"lower": 11, "upper": 60}]}"#
    ) -> Data {
        Data("""
        {
          "directionRows": \(directionRows),
          "entityFrameCount": \(entityFrameCount),
          "tilesets": {"filenameFormat": "%03d-", "indexOffset": 1},
          "characterBands": {"player": \(player), "npc": \(npc), "monster": \(monster)}
        }
        """.utf8)
    }
}
