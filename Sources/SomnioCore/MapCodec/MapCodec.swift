import Foundation

/// Bidirectional codec for the sector on-disk format: JSON `Codable` over a semantic
/// `SectorBody`, carried in `.somnio-sector` files. Modern English field names map directly to
/// JSON keys; NPC facing serializes as a semantic `Direction` case name (`"south"`) rather than
/// the legacy `richtung` int (see `NPC`'s hand-written `Codable`).
///
/// `read`/`write` mirror the wire codec (`SomnioMessageDecoder`/`SomnioMessageEncoder`): a
/// per-call `JSONDecoder`/`JSONEncoder` (no shared mutable state, Sendable-clean). Decode failures
/// surface as `Swift.DecodingError`; encode-time model corruption (an out-of-range NPC direction
/// or sector dimensions) surfaces as `Swift.EncodingError`. Both directions bound `dimensions`
/// against `GridSize.isWithinSectorBounds` (shared with the wire boundary `Sector(_ wire:)`) so a
/// hostile `.somnio-sector` — opened in the editor or loaded from `SOMNIO_SECTORS_DIR` — can't
/// drive an unbounded ground-tile-map allocation, and the writer can't persist a file its own
/// reader would refuse. The reader stays placement-agnostic — it reads the authored `spawnOrigin`
/// verbatim; NPC centering lives in `NPCPlacement.runtimePosition(for:)`.
public enum MapCodec {
    public static func read(_ data: Data) throws -> SectorBody {
        let body = try JSONDecoder().decode(SectorBody.self, from: data)
        guard body.dimensions.isWithinSectorBounds else {
            throw DecodingError.dataCorrupted(DecodingError.Context(
                codingPath: [],
                debugDescription: "sector dimensions out of range: \(body.dimensions.width)x\(body.dimensions.height)"
            ))
        }
        return body
    }

    public static func write(_ sector: SectorBody) throws -> Data {
        guard sector.dimensions.isWithinSectorBounds else {
            throw EncodingError.invalidValue(sector.dimensions, EncodingError.Context(
                codingPath: [],
                debugDescription: "sector dimensions out of range: \(sector.dimensions.width)x\(sector.dimensions.height)"
            ))
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(sector)
    }
}
