import Foundation

/// Single-point overlap test against a sector's `[CollisionMask]`. The client uses
/// this for movement prediction and the server uses it for the authoritative
/// position-validation gate, so both sides must agree on the polarity (right and
/// bottom edges exclusive). Lives in SomnioCore alongside `VisualCenter` so the
/// mirror is enforced by the type system, not by a comment.
public enum CollisionMaskOverlap {
    /// Returns `true` when `position` lies inside any mask in `masks`. Anchor-only
    /// test (no AABB extent against the player sprite) — the legacy `isInside`/
    /// `collides` pair both behave the same way; matching that exactly keeps the
    /// client's predicted move identical to what the server's per-sector actor
    /// would accept.
    public static func contains(_ position: GridPoint, in masks: [CollisionMask]) -> Bool {
        // Endpoints widen to `Int32` so a corrupt sector with an authored mask near
        // `Int16.max` cannot trap the bounds check.
        let positionX = Int32(position.x)
        let positionY = Int32(position.y)
        for mask in masks {
            let maskX = Int32(mask.x)
            let maskY = Int32(mask.y)
            let maskRight = maskX + Int32(mask.width)
            let maskBottom = maskY + Int32(mask.height)
            if positionX >= maskX, positionX < maskRight,
               positionY >= maskY, positionY < maskBottom {
                return true
            }
        }
        return false
    }

    /// Rect-vs-rect AABB overlap. Right and bottom edges are exclusive (same polarity as
    /// `contains(_:in:)`), so two rects flush along a far edge do not count as overlapping.
    /// Mirrors the original `KollisionChecken` bounding-box test. Used by the feet-box move
    /// gate on both client and server.
    public static func overlaps(_ a: PixelRect, _ b: PixelRect) -> Bool {
        a.x < b.maxX && a.maxX > b.x && a.y < b.maxY && a.maxY > b.y
    }

    /// Returns `true` when `rect` overlaps any mask in `masks`. Mask endpoints widen to `Int32`
    /// so a corrupt sector with an authored mask near `Int16.max` cannot trap the bounds check.
    public static func intersects(_ rect: PixelRect, _ masks: [CollisionMask]) -> Bool {
        for mask in masks {
            let maskRect = PixelRect(
                x: Int32(mask.x),
                y: Int32(mask.y),
                width: Int32(mask.width),
                height: Int32(mask.height)
            )
            if overlaps(rect, maskRect) {
                return true
            }
        }
        return false
    }
}
