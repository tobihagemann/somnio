import Foundation

public enum SomnioConstants {
    public static let tileSize: Int16 = 128
    public static let npcInteractionRadius: Int16 = 64
    public static let monsterAggroRadius: Int16 = 192
    public static let perSectorMonsterCap = 3
    public static let npcDialogCooldownSeconds = 3.0
    /// Mid-hour minute marks at which `WorldClock` emits a `DateTick` packet (4 per
    /// game-hour). The hour-rollover emission is produced separately by `WorldClock.tick()`,
    /// so the on-the-wire cadence is 5 emits per hour.
    public static let dateTickMinutes: [Int16] = [12, 24, 36, 48]
}
