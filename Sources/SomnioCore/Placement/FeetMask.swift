import Foundation

/// Axis-aligned integer rectangle in pixel space. Endpoints are `Int32` so a rect derived from
/// a sprite near a sector edge cannot trap the `x + width` add. Right/bottom edges are exclusive,
/// matching `CollisionMaskOverlap`'s point-test polarity.
public struct PixelRect: Sendable, Equatable {
    public var x: Int32
    public var y: Int32
    public var width: Int32
    public var height: Int32

    public init(x: Int32, y: Int32, width: Int32, height: Int32) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public var maxX: Int32 {
        x + width
    }

    public var maxY: Int32 {
        y + height
    }

    /// Geometric center, used by the proximity gates that compare feet positions rather than
    /// sprite top-left origins (the original's `maskxy + maskgroesse / 2`).
    public var center: (x: Int32, y: Int32) {
        (x + width / 2, y + height / 2)
    }
}

/// Derives an entity's feet collision box from its position and **sprite cell size**. The
/// original collision uses a bottom-aligned, full-width sub-rect of the sprite rather than the
/// whole cell, so a character's head can overlap a wall while the feet do not. Mirrors the
/// original `maskgroesse(0) = groesse(0)`, `maskgroesse(1) = groesse(1) / 4 + 4`,
/// `maskxy(0) = xy(0)`, `maskxy(1) = xy(1) + groesse(1) - maskgroesse(1)`
/// (`Somnio_Server.txt` decoded lines 389-390, 770-771). Lives next to `CollisionMaskOverlap`
/// so the client predictor and the server's per-sector actor derive the identical box.
public enum FeetMask {
    public static func rect(forSpriteAt position: GridPoint, spriteSize: GridSize) -> PixelRect {
        let feetHeight = Int32(spriteSize.height) / 4 + 4
        let feetWidth = Int32(spriteSize.width)
        let originX = Int32(position.x)
        let originY = Int32(position.y) + Int32(spriteSize.height) - feetHeight
        return PixelRect(x: originX, y: originY, width: feetWidth, height: feetHeight)
    }

    /// Feet-box center for proximity gates (NPC dialog radius, monster aggro, client bump/portal),
    /// replacing the old sprite-top-left center so gates trigger at the feet, not the head.
    public static func center(forSpriteAt position: GridPoint, spriteSize: GridSize) -> (x: Int32, y: Int32) {
        rect(forSpriteAt: position, spriteSize: spriteSize).center
    }

    /// `true` when the feet box of a `spriteSize` sprite at `position` lies within `sector` bounds
    /// and overlaps neither a static collision mask nor any `blockers` feet box. The single gate the
    /// client predictor and the server's per-sector actor both call, so a predicted move matches
    /// exactly what the actor accepts.
    public static func isClear(at position: GridPoint, spriteSize: GridSize, sector: Sector, blockers: [PixelRect]) -> Bool {
        let feet = rect(forSpriteAt: position, spriteSize: spriteSize)
        guard feet.x >= 0, feet.y >= 0,
              feet.maxX <= sector.pixelWidth, feet.maxY <= sector.pixelHeight
        else { return false }
        if CollisionMaskOverlap.intersects(feet, sector.collisionMasks) { return false }
        for blocker in blockers where CollisionMaskOverlap.overlaps(feet, blocker) {
            return false
        }
        return true
    }

    /// Clamps `position` so a `spriteSize` sprite's feet box stays within `sector` bounds. The
    /// movement predictor clamps its step target with this so a step toward an edge lands the feet
    /// box flush against it instead of stopping up to one tick short. Bounds mirror `isClear`'s
    /// (feet width == sprite width, feet bottom == sprite bottom); the inner `max` keeps a sector
    /// narrower/shorter than the sprite from inverting the clamp range.
    public static func clamped(_ position: GridPoint, spriteSize: GridSize, sector: Sector) -> GridPoint {
        let feetHeight = Int32(spriteSize.height) / 4 + 4
        let maxX = Int32(sector.pixelWidth) - Int32(spriteSize.width)
        let minY = feetHeight - Int32(spriteSize.height)
        let maxY = Int32(sector.pixelHeight) - Int32(spriteSize.height)
        return GridPoint(
            x: Int16(clamping: min(max(Int32(position.x), 0), max(0, maxX))),
            y: Int16(clamping: min(max(Int32(position.y), minY), max(minY, maxY)))
        )
    }
}
