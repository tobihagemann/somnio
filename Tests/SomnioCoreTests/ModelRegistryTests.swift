import Foundation
import SomnioCore
import Testing

// The model registry drives all of the 3D loader's model resolution, so each decode/validation
// mode and pure resolution helper it relies on has a regression guard here.

struct ModelRegistryTests {
    @Test func `bundledRegistry decodes the committed registry and resolves the MVP cast`() throws {
        let registry = try ModelRegistryCodec.bundledRegistry()
        #expect(registry.model(forKind: .player, figure: 0)?.stem == "Knight")
        #expect(registry.model(forKind: .peer, figure: 11)?.stem == "Knight")
        // Both split points pinned from both sides so an over-reaching band can't hide: 12/13
        // are the cleric figures, 14/15 the mage figures (figure = class.rawValue * 2 + gender).
        #expect(registry.model(forKind: .player, figure: 12)?.stem == "Rogue_Hooded")
        #expect(registry.model(forKind: .player, figure: 13)?.stem == "Rogue_Hooded")
        #expect(registry.model(forKind: .player, figure: 14)?.stem == "Mage")
        #expect(registry.model(forKind: .player, figure: 15)?.stem == "Mage")
        #expect(registry.model(forKind: .npc, figure: 16)?.stem == "Lorekeeper")
        #expect(registry.model(forKind: .monster, figure: 0)?.stem == "Ghost")
    }

    /// One entry per distinct object id across the three shipped Edaria fixtures — the
    /// committed table must resolve every one so no shipped sector renders an
    /// unmapped-placeholder object.
    private static let shippedSectorObjectIDs: [(id: String, stem: String)] = [
        ("bookshelf-ornate", "BookshelfOrnate"),
        ("bookshelf", "Bookshelf"),
        ("potted-plant", "PottedPlant"),
        ("study-table", "StudyTable"),
        ("bust", "Bust"),
        ("door", "Door"),
        ("grand-bookcase", "GrandBookcase"),
        ("couch", "Couch"),
        ("floor-lamp", "FloorLamp"),
        ("side-table", "SideTable"),
        ("chair", "Chair"),
        ("tent", "Tent")
    ]

    @Test(arguments: shippedSectorObjectIDs.indices)
    func `bundledRegistry maps every shipped-sector object id to a static prop`(index: Int) throws {
        let (id, stem) = Self.shippedSectorObjectIDs[index]
        let registry = try ModelRegistryCodec.bundledRegistry()
        let model = try #require(registry.model(forObjectID: id))
        #expect(model.stem == stem)
        #expect(model.expectedClips.isEmpty)
    }

    /// The directional locomotion clips must stay in the committed registry for all three
    /// player models: they are the conversion gate's `expectedClips` contract, so dropping one
    /// would let a pack ship without the backpedal/strafe clip and silently fall back to
    /// forward-walk.
    @Test func `bundledRegistry gives every player model the directional locomotion clips`() throws {
        let registry = try ModelRegistryCodec.bundledRegistry()
        let directional = ["Walking_Backwards", "Running_Strafe_Left", "Running_Strafe_Right"]
        for stem in ["Knight", "Rogue_Hooded", "Mage"] {
            let clips = try #require(registry.expectedClips(forStem: stem))
            for clip in directional {
                #expect(clips.contains(clip), "\(stem) is missing \(clip)")
            }
        }
    }

    /// The committed fixtures reference these ids directly, so every fixture reference must
    /// resolve through the committed registry — an unmapped id would ship a placeholder.
    @Test func `bundledRegistry resolves every fixture floor material`() throws {
        let registry = try ModelRegistryCodec.bundledRegistry()
        #expect(registry.floorMaterialStem(forID: "grass-meadow") == "GrassMeadow")
        #expect(registry.floorMaterialStem(forID: "stone-arena") == "StoneArena")
        #expect(registry.floorMaterialStem(forID: "wood-warm") == "WoodWarm")
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

    @Test func `model(forObjectID:) resolves a seeded id and nil for an unmapped one`() throws {
        let objectModels = """
        [{"id": "tree", "model": {"stem": "Tree", "expectedClips": []}}]
        """
        let registry = try ModelRegistryCodec.read(registryJSON(objectModels: objectModels))
        #expect(registry.model(forObjectID: "tree")?.stem == "Tree")
        #expect(registry.model(forObjectID: "rock") == nil)
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
        #expect(registry.model(forObjectID: "door") == nil)
        #expect(registry.floorMaterialStem(forID: "grass") == nil)
        #expect(registry.allModelEntries.isEmpty)
    }

    @Test func `allModelEntries lists each stem once across bands and objects`() throws {
        let objectModels = """
        [{"id": "knight-statue", "model": {"stem": "Knight", "expectedClips": []}}, \
        {"id": "tree", "model": {"stem": "Tree", "expectedClips": []}}]
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
        [{"id": "tree", "model": {"stem": "", "expectedClips": []}}]
        """
        #expect(throws: DecodingError.self) {
            try ModelRegistryCodec.read(registryJSON(objectModels: emptyStem))
        }
        let emptyClip = """
        [{"id": "tree", "model": {"stem": "Tree", "expectedClips": [""]}}]
        """
        #expect(throws: DecodingError.self) {
            try ModelRegistryCodec.read(registryJSON(objectModels: emptyClip))
        }
    }

    @Test func `read rejects an empty object model id`() {
        let objectModels = """
        [{"id": "", "model": {"stem": "Tree", "expectedClips": []}}]
        """
        #expect(throws: DecodingError.self) {
            try ModelRegistryCodec.read(registryJSON(objectModels: objectModels))
        }
    }

    @Test func `read rejects a duplicate object model id`() {
        let entry = """
        {"id": "tree", "model": {"stem": "Tree", "expectedClips": []}}
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
        // Encode-time model corruption surfaces as EncodingError (mirroring MapCodec),
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
        floorMaterials: String = "[]"
    ) -> Data {
        Data("""
        {
          "entityBands": {"player": \(player), "npc": \(npc), "monster": \(monster)},
          "objectModels": \(objectModels),
          "floorMaterials": \(floorMaterials)
        }
        """.utf8)
    }
}
