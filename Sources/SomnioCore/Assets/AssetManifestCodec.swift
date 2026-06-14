import Foundation

/// Bidirectional codec for the committed asset manifest (`AssetManifest.json`). Mirrors `MapCodec`:
/// a per-call `JSONDecoder`/`JSONEncoder` (no shared mutable state, Sendable-clean), decode failures
/// surfacing as `Swift.DecodingError` and encode-time model corruption as `Swift.EncodingError`, and
/// a sorted-keys pretty-print so the committed file stays human-diffable. Both directions validate
/// the structural invariants the synthesized `Codable` alone can't express, so a malformed manifest
/// is rejected rather than producing silently wrong slicing.
public enum AssetManifestCodec {
    public static func read(_ data: Data) throws -> AssetManifest {
        let manifest = try JSONDecoder().decode(AssetManifest.self, from: data)
        if let reason = validationFailure(manifest) {
            throw DecodingError.dataCorrupted(DecodingError.Context(codingPath: [], debugDescription: reason))
        }
        return manifest
    }

    public static func write(_ manifest: AssetManifest) throws -> Data {
        if let reason = validationFailure(manifest) {
            throw EncodingError.invalidValue(manifest, EncodingError.Context(codingPath: [], debugDescription: reason))
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(manifest)
    }

    /// Reads the committed manifest from `SomnioCore`'s own bundle. Keeps SomnioCore's `Bundle.module`
    /// access inside SomnioCore — SomnioUI consumes this API, never the bundle directly.
    public static func bundledLegacy() throws -> AssetManifest {
        guard let url = Bundle.module.url(forResource: "AssetManifest", withExtension: "json") else {
            throw DecodingError.dataCorrupted(DecodingError.Context(
                codingPath: [],
                debugDescription: "AssetManifest.json missing from SomnioCore bundle"
            ))
        }
        return try read(Data(contentsOf: url))
    }

    /// The first structural invariant the manifest violates, or `nil` when valid. Returned as a
    /// reason string so `read` and `write` can each wrap it in the error type their direction
    /// conventionally throws.
    private static func validationFailure(_ manifest: AssetManifest) -> String? {
        if Set(manifest.directionRows) != Set(Direction.allCases) || manifest.directionRows.count != Direction.allCases.count {
            return "directionRows must list each Direction exactly once"
        }
        if manifest.entityFrameCount <= 0 {
            return "entityFrameCount must be positive"
        }
        for band in CharacterBand.allCases {
            if let reason = validationFailure(band: manifest.characterBands[band], named: band) {
                return reason
            }
        }
        return nil
    }

    private static func validationFailure(band rule: BandRule, named band: CharacterBand) -> String? {
        for range in rule.leadingNumberRanges where range.lower > range.upper {
            return "\(band) band has an inverted range \(range.lower)...\(range.upper)"
        }
        switch band {
        case .player:
            guard let grid = rule.sheetGrid, let cell = rule.cell else {
                return "player band must carry both sheetGrid and cell"
            }
            if grid.columns <= 0 || grid.rows <= 0 {
                return "player band sheetGrid must be positive"
            }
            if cell.width <= 0 || cell.height <= 0 {
                return "player band cell must be positive"
            }
        case .npc, .monster:
            if rule.sheetGrid != nil || rule.cell != nil {
                return "\(band) band must not carry sheetGrid or cell (single-region)"
            }
        }
        return nil
    }
}
