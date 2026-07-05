import Foundation

/// Bidirectional codec for the committed model registry (`ModelRegistry.json`). Mirrors
/// `AssetManifestCodec`: per-call `JSONDecoder`/`JSONEncoder`, decode failures surfacing as
/// `Swift.DecodingError` and encode-time model corruption as `Swift.EncodingError`, and a
/// sorted-keys pretty-print so the committed file stays human-diffable. Both directions validate
/// the structural invariants the synthesized `Codable` alone can't express, so a malformed
/// registry is rejected rather than producing silently wrong model resolution.
public enum ModelRegistryCodec {
    public static func read(_ data: Data) throws -> ModelRegistry {
        let registry = try JSONDecoder().decode(ModelRegistry.self, from: data)
        if let reason = validationFailure(registry) {
            throw DecodingError.dataCorrupted(DecodingError.Context(codingPath: [], debugDescription: reason))
        }
        return registry
    }

    public static func write(_ registry: ModelRegistry) throws -> Data {
        if let reason = validationFailure(registry) {
            throw EncodingError.invalidValue(registry, EncodingError.Context(codingPath: [], debugDescription: reason))
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(registry)
    }

    /// Reads the committed registry from `SomnioCore`'s own bundle. Keeps SomnioCore's bundle
    /// access inside SomnioCore — SomnioScene3D consumes this API, never the bundle directly.
    public static func bundledRegistry() throws -> ModelRegistry {
        guard let url = Bundle.somnioCoreModule.url(forResource: "ModelRegistry", withExtension: "json") else {
            throw DecodingError.dataCorrupted(DecodingError.Context(
                codingPath: [],
                debugDescription: "ModelRegistry.json missing from SomnioCore bundle"
            ))
        }
        return try read(Data(contentsOf: url))
    }

    /// The first structural invariant the registry violates, or `nil` when valid. Returned as a
    /// reason string so `read` and `write` can each wrap it in the error type their direction
    /// conventionally throws.
    private static func validationFailure(_ registry: ModelRegistry) -> String? {
        for band in CharacterBand.allCases {
            for rule in registry.entityBands[band] {
                if let reason = validationFailure(entityRule: rule, inBand: band) {
                    return reason
                }
            }
        }
        return validationFailure(objectModels: registry.objectModels)
            ?? validationFailure(floorMaterials: registry.floorMaterials)
            ?? validationFailure(groundMaterials: registry.groundMaterials, floorIDs: Set(registry.floorMaterials.map(\.id)))
    }

    private static func validationFailure(objectModels: [ObjectModelRule]) -> String? {
        var signatures = Set<SourceRectSignature>()
        for rule in objectModels {
            if let reason = validationFailure(model: rule.model, describedAs: "object model \(rule.model.stem)") {
                return reason
            }
            if !signatures.insert(rule.signature).inserted {
                return "duplicate object source-rect signature for tileset \(rule.signature.tilesetIndex) at (\(rule.signature.sourceX), \(rule.signature.sourceY))"
            }
        }
        return nil
    }

    private static func validationFailure(floorMaterials: [FloorMaterialRule]) -> String? {
        var floorIDs = Set<String>()
        for rule in floorMaterials {
            if rule.id.isEmpty {
                return "floor material has an empty id"
            }
            if rule.stem.isEmpty {
                return "floor material \(rule.id) has an empty stem"
            }
            if !floorIDs.insert(rule.id).inserted {
                return "duplicate floor material id \(rule.id)"
            }
        }
        return nil
    }

    private static func validationFailure(groundMaterials: [GroundMaterialRule], floorIDs: Set<String>) -> String? {
        var groundSignatures = Set<GroundMaterialRule>()
        for rule in groundMaterials {
            if !floorIDs.contains(rule.id) {
                return "ground material references unknown floor material id \(rule.id)"
            }
            var signature = rule
            signature.id = ""
            if !groundSignatures.insert(signature).inserted {
                return "duplicate ground material signature for tileset \(rule.tilesetIndex) at (\(rule.sourceX), \(rule.sourceY))"
            }
        }
        return nil
    }

    private static func validationFailure(entityRule rule: FigureModelRule, inBand band: CharacterBand) -> String? {
        for range in rule.figureRanges where range.lower > range.upper {
            return "\(band) band has an inverted figure range \(range.lower)...\(range.upper)"
        }
        if let reason = validationFailure(model: rule.model, describedAs: "\(band) band model \(rule.model.stem)") {
            return reason
        }
        if rule.model.expectedClips.isEmpty {
            return "\(band) band model \(rule.model.stem) must expect at least one animation clip"
        }
        return nil
    }

    private static func validationFailure(model entry: ModelEntry, describedAs description: String) -> String? {
        if entry.stem.isEmpty {
            return "\(description) has an empty stem"
        }
        if entry.expectedClips.contains(where: \.isEmpty) {
            return "\(description) has an empty clip name"
        }
        return nil
    }
}
