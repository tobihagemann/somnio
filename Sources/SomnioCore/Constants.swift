import Foundation
import SomnioProtocol

public enum SomnioConstants {
    public static let tileSize: Int16 = 128
    /// Edge of one ground source-pack cell. `tileSize` (128) is exactly `4 × groundCellSize`
    /// (32), so the ground tile map repeats this cell four times per engine tile and a
    /// sector's pixel extent is always divisible by 32.
    public static let groundCellSize: Int16 = 32
    /// Upper bound on a wire-supplied sector's per-axis tile dimension. Real sectors are tens of
    /// tiles per side; paired with `maxSectorArea`, this caps a malicious or corrupt `EnterSector`
    /// so a peer can't drive the client into allocating an enormous ground tile map (or entity
    /// graph) and exhausting memory. Generous headroom over any legitimate sector.
    public static let maxSectorDimension: Int16 = 1024
    /// Upper bound on a wire-supplied sector's total tile area (`width × height`). The per-axis cap
    /// alone still admits a `1024 × 1024` sector, whose ground tile map is ~16.7M cells; this area
    /// cap bounds the actual allocation driver. 256 × 256 tiles is ~400x the largest real sector.
    public static let maxSectorArea: Int32 = 65536
    /// Upper bound on a sector's object count. The wire frame cap already bounds it coarsely
    /// (~10k objects fit in one frame), but the 3D renderer's bottom-edge anchor scans every
    /// collision mask per object on the main actor, so a frame at the coarse bound still
    /// freezes the client for seconds. Generous headroom over any real sector (the richest
    /// fixture carries 33 objects).
    public static let maxSectorObjects = 4096
    /// Companion cap for `maxSectorObjects`: the other factor of the renderer's
    /// objects × collisionMasks anchor scan (the richest fixture carries 21 masks).
    public static let maxSectorCollisionMasks = 4096
    /// Caps for the remaining record arrays. Each drives per-record work on load — authoring
    /// overlay rects in the editor, spawn/dialog runtimes on the server — so a hostile file or
    /// frame with an unbounded array could freeze its consumer. Generous headroom over any
    /// real sector (the richest fixture carries 3 portals and 1 NPC).
    public static let maxSectorPortals = 4096
    public static let maxSectorNPCs = 4096
    public static let maxSectorMonsterSpawns = 4096
    /// Cap on the objects × collisionMasks product: the renderer's bottom-edge anchor scan is
    /// O(objects × collisionMasks), so the per-array caps alone would still admit ~16.7M
    /// pairings from a hostile sector with both arrays at their limits. 2^20 pairings bounds
    /// the scan to milliseconds while dwarfing any real sector (the richest fixture pairs
    /// 33 × 21 ≈ 700).
    public static let maxSectorAnchorScanPairings = 1_048_576
    /// Byte cap on a `.somnio-sector` file, checked before JSON decoding: the count caps only
    /// fire after `JSONDecoder` has already parsed the whole input, so without a size
    /// preflight a multi-gigabyte hostile file stalls the opener inside the parser. A sector
    /// at every content cap pretty-prints to a few megabytes, so 16 MiB is generous headroom.
    public static let maxSectorFileBytes = 16 * 1_048_576
    /// The one content-count bound both untrusted sector seams gate on — the wire boundary
    /// (`Sector(_ wire:)`) and the disk codec (`MapCodec` via
    /// `SectorBody.hasContentCountsWithinBounds`) — mirroring how they share
    /// `GridSize.isWithinSectorBounds` for dimensions.
    public static func isWithinSectorContentBounds(
        objectCount: Int,
        collisionMaskCount: Int,
        portalCount: Int,
        npcCount: Int,
        monsterSpawnCount: Int
    ) -> Bool {
        objectCount <= maxSectorObjects && collisionMaskCount <= maxSectorCollisionMasks
            && objectCount * collisionMaskCount <= maxSectorAnchorScanPairings
            && portalCount <= maxSectorPortals && npcCount <= maxSectorNPCs
            && monsterSpawnCount <= maxSectorMonsterSpawns
    }

    /// Byte cap on a wire-supplied entity display name the renderer rasterizes into a name
    /// plaque, derived from the protocol's identifier cap that honest servers already
    /// enforce at registration. Without a client-side clamp a hostile or corrupt
    /// `EntityMessage` name drives an enormous supersampled plaque bitmap — and a
    /// world-sized blank quad when the oversized texture upload then fails.
    public static let maxRenderedNameUTF8Bytes = SomnioProtocolConstants.maxIdentifierUTF8Bytes
    /// Speech-bubble text metrics shared by the wrap step (SomnioUI's `SpeechBubbleText`)
    /// and the balloon renderer (SomnioScene3D's `SpeechBubbleArt`): lines are wrapped
    /// against this width at this font size and drawn back at the same metrics, so both
    /// consumers must resolve to this single source of truth or wrapped lines overflow the
    /// balloon body. 150 px matches the legacy balloon template width. Typed like the
    /// file's other dimensions — the CGFloat-native consumers convert at use, keeping
    /// SomnioCore free of CoreGraphics types (`DayNightAmbient`'s documented decision).
    public static let speechBubbleWidthPixels: Int16 = 150
    public static let speechBubbleFontSize: Double = 10

    /// Player sprite cell size (32 × 48 in the `001-Main01.png` sheet). Distinct from
    /// `tileSize`: the player entity emits this as its mask cell size, and the feet collision
    /// box is derived from it. NPC/monster sprite cells carry their own per-record size.
    public static let playerSpriteSize = GridSize(width: 32, height: 48)
    public static let npcInteractionRadius: Int16 = 64
    public static let monsterAggroRadius: Int16 = 192
    public static let perSectorMonsterCap = 3
    public static let npcDialogCooldownSeconds = 3.0
    /// Mid-hour minute marks at which `WorldClock` emits a `DateTick` packet (4 per
    /// game-hour). The hour-rollover emission is produced separately by `WorldClock.tick()`,
    /// so the on-the-wire cadence is 5 emits per hour.
    public static let dateTickMinutes: [Int16] = [12, 24, 36, 48]
}
