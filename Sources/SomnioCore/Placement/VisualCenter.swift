import Foundation

/// Visual-center geometry helpers for radius gates that compare entity centers, not their
/// top-left origins. Used by the AI tick to decide whether a player is within an NPC's
/// dialog radius (`SomnioConstants.npcInteractionRadius`) or a monster's aggro radius
/// (`SomnioConstants.monsterAggroRadius`). Lives next to `NPCPlacement` because both
/// helpers materialize runtime geometry the codec deliberately keeps out.
///
/// Centers are computed in `Int32` and squared distances accumulate in `Int64` so a player
/// at the edge of a sector with `dimensions.width` near `Int16.max` cannot trap the AI
/// tick on the `position + mask/2` add or on the `dx*dx + dy*dy` square.
public enum VisualCenter {
    public static func center(position: GridPoint, mask: GridSize) -> (x: Int32, y: Int32) {
        (
            Int32(position.x) + Int32(mask.width) / 2,
            Int32(position.y) + Int32(mask.height) / 2
        )
    }

    public static func squaredDistance(_ a: (x: Int32, y: Int32), _ b: (x: Int32, y: Int32)) -> Int64 {
        let dx = Int64(a.x) - Int64(b.x)
        let dy = Int64(a.y) - Int64(b.y)
        return dx * dx + dy * dy
    }

    /// Inclusive radius gate: a point exactly at the radius is inside.
    public static func isWithin(_ a: (x: Int32, y: Int32), _ b: (x: Int32, y: Int32), radius: Int16) -> Bool {
        let r = Int64(radius)
        return squaredDistance(a, b) <= r * r
    }
}
