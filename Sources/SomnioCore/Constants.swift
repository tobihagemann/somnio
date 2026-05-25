import Foundation

public enum SomnioConstants {
    public static let tileSize: Int16 = 128
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
