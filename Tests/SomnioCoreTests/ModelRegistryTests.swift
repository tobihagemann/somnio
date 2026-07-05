import Foundation
import SomnioCore
import Testing

// The model registry drives all of the 3D loader's model resolution, so each decode/validation
// mode and pure resolution helper it relies on has a regression guard here.

struct ModelRegistryTests {
    @Test func `bundledRegistry decodes the committed registry and resolves the MVP cast`() throws {
        let registry = try ModelRegistryCodec.bundledRegistry()
        #expect(registry.model(forKind: .player, figure: 0)?.stem == "Knight")
        #expect(registry.model(forKind: .peer, figure: 15)?.stem == "Knight")
        #expect(registry.model(forKind: .npc, figure: 16)?.stem == "Lorekeeper")
        #expect(registry.model(forKind: .monster, figure: 0)?.stem == "Ghost")
    }

    /// One entry per distinct source-rect signature across the three shipped Edaria fixtures
    /// (the Arena counter is the Bibliothek one) — the committed table must resolve every one
    /// so no shipped sector renders an unmapped-placeholder object.
    private static let shippedSectorSignatures: [(signature: SourceRectSignature, stem: String)] = [
        (SourceRectSignature(tilesetIndex: 25, sourceX: 64, sourceY: 512, sourceWidth: 64, sourceHeight: 96), "BookshelfOrnate"),
        (SourceRectSignature(tilesetIndex: 25, sourceX: 0, sourceY: 512, sourceWidth: 64, sourceHeight: 96), "Bookshelf"),
        (SourceRectSignature(tilesetIndex: 25, sourceX: 128, sourceY: 608, sourceWidth: 32, sourceHeight: 64), "PottedPlant"),
        (SourceRectSignature(tilesetIndex: 25, sourceX: 160, sourceY: 608, sourceWidth: 32, sourceHeight: 64), "StudyTable"),
        (SourceRectSignature(tilesetIndex: 25, sourceX: 192, sourceY: 608, sourceWidth: 32, sourceHeight: 64), "Bust"),
        (SourceRectSignature(tilesetIndex: 50, sourceX: 64, sourceY: 32, sourceWidth: 192, sourceHeight: 32), "Door"),
        (SourceRectSignature(tilesetIndex: 9, sourceX: 0, sourceY: 224, sourceWidth: 96, sourceHeight: 64), "GrandBookcase"),
        (SourceRectSignature(tilesetIndex: 25, sourceX: 192, sourceY: 288, sourceWidth: 32, sourceHeight: 32), "Couch"),
        (SourceRectSignature(tilesetIndex: 9, sourceX: 192, sourceY: 352, sourceWidth: 32, sourceHeight: 64), "FloorLamp"),
        (SourceRectSignature(tilesetIndex: 25, sourceX: 192, sourceY: 544, sourceWidth: 32, sourceHeight: 64), "SideTable"),
        (SourceRectSignature(tilesetIndex: 13, sourceX: 128, sourceY: 224, sourceWidth: 32, sourceHeight: 64), "Chair"),
        (SourceRectSignature(tilesetIndex: 0, sourceX: 0, sourceY: 416, sourceWidth: 160, sourceHeight: 160), "Tent")
    ]

    @Test(arguments: shippedSectorSignatures.indices)
    func `bundledRegistry maps every shipped-sector object signature to a static prop`(index: Int) throws {
        let (signature, stem) = Self.shippedSectorSignatures[index]
        let registry = try ModelRegistryCodec.bundledRegistry()
        let model = try #require(registry.model(forSignature: signature))
        #expect(model.stem == stem)
        #expect(model.expectedClips.isEmpty)
    }

    @Test func `a valid registry round-trips through write and read`() throws {
        let registry = try ModelRegistryCodec.read(registryJSON())
        let data = try ModelRegistryCodec.write(registry)
        let decoded = try ModelRegistryCodec.read(data)
        #expect(decoded == registry)
    }

    @Test func `model(forKind:figure:) returns nil for an unmapped figure`() throws {
        let registry = try ModelRegistryCodec.read(registryJSON())
        #expect(registry.model(forKind: .npc, figure: 99) == nil)
        #expect(registry.model(forKind: .monster, figure: 1) == nil)
    }

    @Test func `model(forSignature:) resolves a seeded signature and nil for an unmapped one`() throws {
        let objectModels = """
        [{"signature": {"tilesetIndex": 4, "sourceX": 0, "sourceY": 96, "sourceWidth": 64, "sourceHeight": 96}, \
        "model": {"stem": "Tree", "expectedClips": []}}]
        """
        let registry = try ModelRegistryCodec.read(registryJSON(objectModels: objectModels))
        let seeded = SourceRectSignature(tilesetIndex: 4, sourceX: 0, sourceY: 96, sourceWidth: 64, sourceHeight: 96)
        #expect(registry.model(forSignature: seeded)?.stem == "Tree")
        let unmapped = SourceRectSignature(tilesetIndex: 4, sourceX: 64, sourceY: 96, sourceWidth: 64, sourceHeight: 96)
        #expect(registry.model(forSignature: unmapped) == nil)
    }

    @Test func `a SourceRectSignature derives its five fields from an Object`() {
        let object = Object(x: 3, y: 7, tilesetIndex: 4, sourceX: 0, sourceY: 96, sourceWidth: 64, sourceHeight: 96, priority: 1)
        let signature = SourceRectSignature(object)
        #expect(signature == SourceRectSignature(tilesetIndex: 4, sourceX: 0, sourceY: 96, sourceWidth: 64, sourceHeight: 96))
    }

    @Test func `floorMaterialStem resolves a mapped id and nil for an unmapped one`() throws {
        let floorMaterials = #"[{"id": "grass", "stem": "GrassAlbedo"}]"#
        let registry = try ModelRegistryCodec.read(registryJSON(floorMaterials: floorMaterials))
        #expect(registry.floorMaterialStem(forID: "grass") == "GrassAlbedo")
        #expect(registry.floorMaterialStem(forID: "sand") == nil)
    }

    @Test func `expectedClips(forStem:) recovers a model's clip contract by stem`() throws {
        let registry = try ModelRegistryCodec.read(registryJSON())
        #expect(registry.expectedClips(forStem: "Knight") == ["Idle", "Walking_A"])
        #expect(registry.expectedClips(forStem: "NoSuchModel") == nil)
    }

    @Test func `missingClips is empty when all expected clips are present`() {
        let missing = ModelRegistry.missingClips(expected: ["Idle", "Walking_A"], actual: ["Idle", "Walking_A", "Cheer"])
        #expect(missing.isEmpty)
    }

    @Test func `missingClips names the clips a collapsed conversion dropped`() {
        let missing = ModelRegistry.missingClips(expected: ["Idle", "Walking_A", "Running_A"], actual: ["Idle"])
        #expect(missing == ["Walking_A", "Running_A"])
    }

    @Test func `placeholderFallback resolves nothing`() {
        let registry = ModelRegistry.placeholderFallback
        #expect(registry.model(forKind: .player, figure: 0) == nil)
        #expect(registry.model(forSignature: SourceRectSignature(tilesetIndex: 0, sourceX: 0, sourceY: 0, sourceWidth: 1, sourceHeight: 1)) == nil)
        #expect(registry.floorMaterialStem(forID: "grass") == nil)
        #expect(registry.allModelEntries.isEmpty)
    }

    @Test func `allModelEntries lists each stem once across bands and objects`() throws {
        let objectModels = """
        [{"signature": {"tilesetIndex": 4, "sourceX": 0, "sourceY": 96, "sourceWidth": 64, "sourceHeight": 96}, \
        "model": {"stem": "Knight", "expectedClips": []}}, \
        {"signature": {"tilesetIndex": 4, "sourceX": 64, "sourceY": 96, "sourceWidth": 64, "sourceHeight": 96}, \
        "model": {"stem": "Tree", "expectedClips": []}}]
        """
        let registry = try ModelRegistryCodec.read(registryJSON(objectModels: objectModels))
        #expect(registry.allModelEntries.map(\.stem) == ["Knight", "Mage", "Ghost", "Tree"])
    }

    // Validation rejections are driven through `read(Data:)` — the production protection path
    // (`ModelRegistryCodec.bundledRegistry` → `read`) — rather than `write`, so the JSON a corrupt
    // registry file would carry is what the validator actually sees.

    @Test func `read rejects an inverted figure range`() {
        let npc = """
        [{"figureRanges": [{"lower": 16, "upper": 2}], "model": {"stem": "Mage", "expectedClips": ["Idle"]}}]
        """
        #expect(throws: DecodingError.self) {
            try ModelRegistryCodec.read(registryJSON(npc: npc))
        }
    }

    @Test func `read rejects a character entry with no expected clips`() {
        let npc = """
        [{"figureRanges": [{"lower": 16, "upper": 16}], "model": {"stem": "Mage", "expectedClips": []}}]
        """
        #expect(throws: DecodingError.self) {
            try ModelRegistryCodec.read(registryJSON(npc: npc))
        }
    }

    @Test func `read rejects an empty model stem`() {
        let npc = """
        [{"figureRanges": [{"lower": 16, "upper": 16}], "model": {"stem": "", "expectedClips": ["Idle"]}}]
        """
        #expect(throws: DecodingError.self) {
            try ModelRegistryCodec.read(registryJSON(npc: npc))
        }
    }

    @Test func `read rejects an empty clip name`() {
        let npc = """
        [{"figureRanges": [{"lower": 16, "upper": 16}], "model": {"stem": "Mage", "expectedClips": [""]}}]
        """
        #expect(throws: DecodingError.self) {
            try ModelRegistryCodec.read(registryJSON(npc: npc))
        }
    }

    @Test func `read rejects an object model with an empty stem or clip name`() {
        let emptyStem = """
        [{"signature": {"tilesetIndex": 4, "sourceX": 0, "sourceY": 96, "sourceWidth": 64, "sourceHeight": 96}, \
        "model": {"stem": "", "expectedClips": []}}]
        """
        #expect(throws: DecodingError.self) {
            try ModelRegistryCodec.read(registryJSON(objectModels: emptyStem))
        }
        let emptyClip = """
        [{"signature": {"tilesetIndex": 4, "sourceX": 0, "sourceY": 96, "sourceWidth": 64, "sourceHeight": 96}, \
        "model": {"stem": "Tree", "expectedClips": [""]}}]
        """
        #expect(throws: DecodingError.self) {
            try ModelRegistryCodec.read(registryJSON(objectModels: emptyClip))
        }
    }

    @Test func `read rejects a duplicate object signature`() {
        let entry = """
        {"signature": {"tilesetIndex": 4, "sourceX": 0, "sourceY": 96, "sourceWidth": 64, "sourceHeight": 96}, \
        "model": {"stem": "Tree", "expectedClips": []}}
        """
        #expect(throws: DecodingError.self) {
            try ModelRegistryCodec.read(registryJSON(objectModels: "[\(entry), \(entry)]"))
        }
    }

    @Test func `read rejects a duplicate floor material id`() {
        let floorMaterials = #"[{"id": "grass", "stem": "GrassAlbedo"}, {"id": "grass", "stem": "GrassDark"}]"#
        #expect(throws: DecodingError.self) {
            try ModelRegistryCodec.read(registryJSON(floorMaterials: floorMaterials))
        }
    }

    @Test func `read rejects an empty floor material id or stem`() {
        #expect(throws: DecodingError.self) {
            try ModelRegistryCodec.read(registryJSON(floorMaterials: #"[{"id": "", "stem": "GrassAlbedo"}]"#))
        }
        #expect(throws: DecodingError.self) {
            try ModelRegistryCodec.read(registryJSON(floorMaterials: #"[{"id": "grass", "stem": ""}]"#))
        }
    }

    @Test func `write throws EncodingError on an invalid registry`() {
        // Encode-time model corruption surfaces as EncodingError (mirroring AssetManifestCodec),
        // distinct from read's DecodingError.
        let registry = ModelRegistry(
            entityBands: EntityModelBands(
                player: [FigureModelRule(figureRanges: [BandRange(lower: 0, upper: 15)], model: ModelEntry(stem: "Knight"))],
                npc: [],
                monster: []
            ),
            objectModels: [],
            floorMaterials: []
        )
        #expect(throws: EncodingError.self) { try ModelRegistryCodec.write(registry) }
    }

    // MARK: - Helpers

    /// Builds registry JSON from seeded defaults, overriding one fragment per test so each
    /// rejection case feeds the validator exactly the JSON a corrupt registry file would carry.
    @Test func `groundMaterials bridge resolves a ground signature to its floor-material stem`() throws {
        let registry = try ModelRegistryCodec.read(registryJSON(
            floorMaterials: #"[{"id": "wood-warm", "stem": "WoodWarm"}]"#,
            groundMaterials: #"[{"tilesetIndex": 25, "sourceX": 64, "sourceY": 0, "id": "wood-warm"}]"#
        ))
        #expect(registry.floorMaterialStem(forGroundTileset: 25, sourceX: 64, sourceY: 0) == "WoodWarm")
        #expect(registry.floorMaterialStem(forGroundTileset: 25, sourceX: 0, sourceY: 0) == nil)
    }

    @Test func `a ground material referencing an unknown floor-material id is rejected`() {
        #expect(throws: DecodingError.self) {
            _ = try ModelRegistryCodec.read(registryJSON(
                groundMaterials: #"[{"tilesetIndex": 0, "sourceX": 0, "sourceY": 0, "id": "missing"}]"#
            ))
        }
    }

    @Test func `duplicate ground material signatures are rejected`() {
        #expect(throws: DecodingError.self) {
            _ = try ModelRegistryCodec.read(registryJSON(
                floorMaterials: #"[{"id": "a", "stem": "A"}, {"id": "b", "stem": "B"}]"#,
                groundMaterials: #"""
                [{"tilesetIndex": 0, "sourceX": 0, "sourceY": 0, "id": "a"},
                 {"tilesetIndex": 0, "sourceX": 0, "sourceY": 0, "id": "b"}]
                """#
            ))
        }
    }

    private func registryJSON(
        player: String = """
        [{"figureRanges": [{"lower": 0, "upper": 15}], "model": {"stem": "Knight", "expectedClips": ["Idle", "Walking_A"]}}]
        """,
        npc: String = """
        [{"figureRanges": [{"lower": 16, "upper": 16}], "model": {"stem": "Mage", "expectedClips": ["Idle", "Walking_A"]}}]
        """,
        monster: String = """
        [{"figureRanges": [{"lower": 0, "upper": 0}], "model": {"stem": "Ghost", "expectedClips": ["Flying_Idle"]}}]
        """,
        objectModels: String = "[]",
        floorMaterials: String = "[]",
        groundMaterials: String = "[]"
    ) -> Data {
        Data("""
        {
          "entityBands": {"player": \(player), "npc": \(npc), "monster": \(monster)},
          "objectModels": \(objectModels),
          "floorMaterials": \(floorMaterials),
          "groundMaterials": \(groundMaterials)
        }
        """.utf8)
    }
}
