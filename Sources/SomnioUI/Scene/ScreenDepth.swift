import CoreGraphics
import Foundation

/// Painter's-algorithm depth shared by object decals and entity sprites, mirroring the original
/// `PrioritySetzen`. Depth rises with the feet-line Y in the sector's Y-down coordinate space, so
/// a sprite lower in the world (further south, drawn lower on screen) renders in front. A single
/// continuous scale for objects and entities lets a character pass behind a tall object's top
/// while staying in front of its base. Larger values map to higher `SKNode.zPosition`.
///
/// `legacyY` is a node's top-left Y in sector (Y-down) coordinates — the same space the original's
/// `ScreenY` uses, up to a constant camera offset that cancels out of the relative ordering.
enum ScreenDepth {
    /// Legacy `mindestpriority` floor added to every depth.
    private static let minimumPriority: CGFloat = 1
    /// Legacy `hoechstpriority = Spielfeld.Height` — the constant that lifts a priority-class-1
    /// object above the feet-line ordering so it always draws over class-0 decals at the same Y.
    private static let highPriorityBonus: CGFloat = 480

    /// Entity feet-line depth: `(ScreenY + Height - Height/4 + 4) / 4 + mindestpriority`
    /// (`Somnio.txt` client strings line 13749).
    static func entity(legacyY: CGFloat, height: CGFloat) -> CGFloat {
        (legacyY + height - height / 4 + 4) / 4 + minimumPriority
    }

    /// Object decal depth. Priority-class 0 uses the feet-line; class 1 adds `hoechstpriority`
    /// so it sits above class-0 decals (`Somnio.txt` client strings lines 12266/12268).
    static func object(legacyY: CGFloat, height: CGFloat, priority: Int16) -> CGFloat {
        let base = legacyY + height - height / 4
        let bonus = priority >= 1 ? highPriorityBonus : 0
        return (base + bonus) / 4 + minimumPriority
    }
}
