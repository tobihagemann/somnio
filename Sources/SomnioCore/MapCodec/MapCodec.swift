import Foundation

/// Bidirectional codec for the sector on-disk format: JSON `Codable` over a semantic
/// `SectorBody`, carried in `.somnio-sector` files. Modern English field names map directly to
/// JSON keys; NPC facing serializes as heading degrees under the stable `"direction"` key
/// (`"direction" : 270`; see `NPC`'s `CodingKeys`).
///
/// `read`/`write` mirror the wire codec (`SomnioMessageDecoder`/`SomnioMessageEncoder`): a
/// per-call `JSONDecoder`/`JSONEncoder` (no shared mutable state, Sendable-clean). Decode failures
/// surface as `Swift.DecodingError`; encode-time model corruption (out-of-range sector
/// dimensions) surfaces as `Swift.EncodingError`. Both directions bound `dimensions`
/// against `GridSize.isWithinSectorBounds` and the object/collision-mask counts against
/// `SectorBody.hasContentCountsWithinBounds` (both shared with the wire boundary
/// `Sector(_ wire:)`) so a hostile `.somnio-sector` — opened in the editor or loaded from
/// `SOMNIO_SECTORS_DIR` — can't drive an unbounded ground-tile-map allocation or a quadratic
/// render-anchor scan, and the writer can't persist a file its own reader would refuse. The reader stays placement-agnostic — it reads the authored `spawnOrigin`
/// verbatim; NPC centering lives in `NPCPlacement.runtimePosition(for:)`.
public enum MapCodec {
    public static func read(_ data: Data) throws -> SectorBody {
        // Size preflight: the count caps below only fire after the decoder has parsed the
        // whole input, so an unbounded file must be rejected before `JSONDecoder` runs.
        guard data.count <= SomnioConstants.maxSectorFileBytes else {
            throw DecodingError.dataCorrupted(DecodingError.Context(
                codingPath: [],
                debugDescription: "sector file size out of range: \(data.count) bytes"
            ))
        }
        let body = try JSONDecoder().decode(SectorBody.self, from: data)
        guard body.dimensions.isWithinSectorBounds else {
            throw DecodingError.dataCorrupted(DecodingError.Context(
                codingPath: [],
                debugDescription: "sector dimensions out of range: \(body.dimensions.width)x\(body.dimensions.height)"
            ))
        }
        guard body.hasContentCountsWithinBounds else {
            throw DecodingError.dataCorrupted(DecodingError.Context(
                codingPath: [],
                debugDescription: "sector content counts out of range: \(body.objects.count) objects, \(body.collisionMasks.count) collision masks, \(body.portals.count) portals, \(body.npcs.count) npcs, \(body.monsterSpawns.count) monster spawns"
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
        guard sector.hasContentCountsWithinBounds else {
            throw EncodingError.invalidValue(sector, EncodingError.Context(
                codingPath: [],
                debugDescription: "sector content counts out of range: \(sector.objects.count) objects, \(sector.collisionMasks.count) collision masks, \(sector.portals.count) portals, \(sector.npcs.count) npcs, \(sector.monsterSpawns.count) monster spawns"
            ))
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(sector)
        guard data.count <= SomnioConstants.maxSectorFileBytes else {
            throw EncodingError.invalidValue(sector, EncodingError.Context(
                codingPath: [],
                debugDescription: "sector file size out of range: \(data.count) bytes"
            ))
        }
        return data
    }
}
