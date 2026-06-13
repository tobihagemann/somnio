import Foundation

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
