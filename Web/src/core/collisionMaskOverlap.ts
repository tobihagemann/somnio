import type { GridPoint, PixelRect } from './geometry'
import { maxX, maxY } from './geometry'
import type { CollisionMask } from './sector'

/**
 * Mirror of `Sources/SomnioCore/Placement/CollisionMaskOverlap.swift`. The client predictor and
 * the server's per-sector actor must agree on the polarity — right and bottom edges exclusive —
 * or a predicted move diverges from what the server accepts.
 */

/**
 * `true` when `position` lies inside any mask. Anchor-only test with no sprite extent, matching
 * the legacy behaviour that the feet-box gate is layered on top of.
 */
export function contains(position: GridPoint, masks: readonly CollisionMask[]): boolean {
  for (const mask of masks) {
    const right = mask.x + mask.width
    const bottom = mask.y + mask.height
    if (position.x >= mask.x && position.x < right && position.y >= mask.y && position.y < bottom) {
      return true
    }
  }
  return false
}

/**
 * Rect-vs-rect AABB overlap. Right and bottom edges are exclusive, so two rects flush along a
 * far edge do **not** count as overlapping — the single most load-bearing detail here, because
 * an inclusive comparison makes every wall one pixel thicker than the server thinks it is.
 */
export function overlaps(a: PixelRect, b: PixelRect): boolean {
  return a.x < maxX(b) && maxX(a) > b.x && a.y < maxY(b) && maxY(a) > b.y
}

export function intersects(rect: PixelRect, masks: readonly CollisionMask[]): boolean {
  for (const mask of masks) {
    if (overlaps(rect, { x: mask.x, y: mask.y, width: mask.width, height: mask.height })) {
      return true
    }
  }
  return false
}
