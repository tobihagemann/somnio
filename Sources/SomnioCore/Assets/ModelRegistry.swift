import Foundation

/// One USDZ model reference: the filename stem resolved under the pack's `Models/` subtree plus
/// the named animation clips the game plays from it. `expectedClips` doubles as the clip-presence
/// contract: conversion tooling and the runtime loader both assert these names survive the
/// glb→USDZ conversion (a naive export collapses the clip library into a single timeline).
/// Static props carry an empty clip list.
public struct ModelEntry: Sendable, Equatable, Hashable, Codable {
    public var stem: String
    public var expectedClips: [String]

    public init(stem: String, expectedClips: [String] = []) {
        self.stem = stem
        self.expectedClips = expectedClips
    }
}

/// Maps a range of figure indices within one character band to a model. Figure indices are the
/// band-positional identity the wire protocol carries (`WorldEntity.figure`), reusing `BandRange`
/// for the self-documenting `lower`/`upper` JSON shape.
public struct FigureModelRule: Sendable, Equatable, Hashable, Codable {
    public var figureRanges: [BandRange]
    public var model: ModelEntry

    public init(figureRanges: [BandRange], model: ModelEntry) {
        self.figureRanges = figureRanges
        self.model = model
    }

    public func containsFigure(_ figure: Int) -> Bool {
        figureRanges.contains { $0.contains(figure) }
    }
}

/// Per-band figure→model rules, mirroring `CharacterBands`' player/npc/monster shape so the
/// registry JSON reads symmetrically with the 2D manifest it supersedes.
public struct EntityModelBands: Sendable, Equatable, Hashable, Codable {
    public var player: [FigureModelRule]
    public var npc: [FigureModelRule]
    public var monster: [FigureModelRule]

    public init(player: [FigureModelRule], npc: [FigureModelRule], monster: [FigureModelRule]) {
        self.player = player
        self.npc = npc
        self.monster = monster
    }

    public subscript(_ band: CharacterBand) -> [FigureModelRule] {
        switch band {
        case .player: return player
        case .npc: return npc
        case .monster: return monster
        }
    }
}

/// The five `Object` fields that identify an authored 2D decal, used as the compatibility lookup
/// key from the unchanged sector format to a 3D model — the interim keying until the sector
/// format gains an explicit model-id field.
public struct SourceRectSignature: Sendable, Equatable, Hashable, Codable {
    public var tilesetIndex: Int16
    public var sourceX: Int16
    public var sourceY: Int16
    public var sourceWidth: Int16
    public var sourceHeight: Int16

    public init(tilesetIndex: Int16, sourceX: Int16, sourceY: Int16, sourceWidth: Int16, sourceHeight: Int16) {
        self.tilesetIndex = tilesetIndex
        self.sourceX = sourceX
        self.sourceY = sourceY
        self.sourceWidth = sourceWidth
        self.sourceHeight = sourceHeight
    }

    public init(_ object: Object) {
        self.init(
            tilesetIndex: object.tilesetIndex,
            sourceX: object.sourceX,
            sourceY: object.sourceY,
            sourceWidth: object.sourceWidth,
            sourceHeight: object.sourceHeight
        )
    }
}

/// One authored-object→model mapping. An ordered array of these (not a raw dictionary) keeps the
/// committed JSON stable and self-documenting, matching the wire-payload convention.
public struct ObjectModelRule: Sendable, Equatable, Hashable, Codable {
    public var signature: SourceRectSignature
    public var model: ModelEntry

    public init(signature: SourceRectSignature, model: ModelEntry) {
        self.signature = signature
        self.model = model
    }
}

/// Maps a floor-material reference id to its asset stem under the pack's `FloorMaterials/`
/// subtree. The string id key is provisional: the sector format has no per-tile floor-material
/// field yet, so the key shape is finalized when that field lands with the editor pivot.
public struct FloorMaterialRule: Sendable, Equatable, Hashable, Codable {
    public var id: String
    public var stem: String

    public init(id: String, stem: String) {
        self.id = id
        self.stem = stem
    }
}

/// Data-driven description of the 3D model pack, superseding `AssetManifest`'s 2D sprite
/// conventions for the RealityKit render path (the 2D manifest stays alongside it while the
/// editor preview still consumes the sprite pack). The registry references only filename stems,
/// so it never drifts from the uncommitted, operator-supplied model pack. All resolution is
/// pure and unit-testable without a live renderer; an unmapped lookup returns `nil`, which the
/// loader renders as a placeholder rather than an error.
public struct ModelRegistry: Sendable, Equatable, Codable {
    public var entityBands: EntityModelBands
    public var objectModels: [ObjectModelRule]
    public var floorMaterials: [FloorMaterialRule]

    public init(entityBands: EntityModelBands, objectModels: [ObjectModelRule], floorMaterials: [FloorMaterialRule]) {
        self.entityBands = entityBands
        self.objectModels = objectModels
        self.floorMaterials = floorMaterials
    }

    /// The model for an entity's band + figure identity, or `nil` when no rule claims the figure.
    /// Players and peers share the player band, mirroring the sprite loader's kind mapping.
    public func model(forKind kind: WorldEntity.Kind, figure: Int16) -> ModelEntry? {
        let band: CharacterBand = switch kind {
        case .player, .peer: .player
        case .npc: .npc
        case .monster: .monster
        }
        return entityBands[band].first { $0.containsFigure(Int(figure)) }?.model
    }

    /// The model for an authored object's source-rect signature, or `nil` (⇒ placeholder) when
    /// the signature is unmapped.
    public func model(forSignature signature: SourceRectSignature) -> ModelEntry? {
        objectModels.first { $0.signature == signature }?.model
    }

    /// The floor-material asset stem for a reference id, or `nil` when the id is unmapped.
    public func floorMaterialStem(forID id: String) -> String? {
        floorMaterials.first { $0.id == id }?.stem
    }

    /// The expected clip names for a model stem, searching entity bands before object rules, or
    /// `nil` when no entry references the stem. Lets the conversion-time validator recover a
    /// model's clip contract from its output filename alone.
    public func expectedClips(forStem stem: String) -> [String]? {
        allModelEntries.first { $0.stem == stem }?.expectedClips
    }

    /// Every model entry in the registry, entity bands first, preserving declaration order but
    /// dropping duplicate stems — the prewarm/conversion work list.
    public var allModelEntries: [ModelEntry] {
        let entries = CharacterBand.allCases.flatMap { entityBands[$0].map(\.model) } + objectModels.map(\.model)
        var seen = Set<String>()
        return entries.filter { seen.insert($0.stem).inserted }
    }

    /// The expected clip names absent from a loaded model's actual clips — the pure half of the
    /// clip-presence gate shared by the conversion validator and the runtime loader.
    public static func missingClips(expected: [String], actual: [String]) -> Set<String> {
        Set(expected).subtracting(actual)
    }

    /// Empty registry used when the committed `ModelRegistry.json` resource is (theoretically)
    /// missing or corrupt: every lookup resolves `nil`, so the loader degrades to placeholders
    /// with a logged error rather than trapping — the same graceful path as an absent model pack.
    public static let placeholderFallback = ModelRegistry(
        entityBands: EntityModelBands(player: [], npc: [], monster: []),
        objectModels: [],
        floorMaterials: []
    )
}
