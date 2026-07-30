/**
 * Mirror of `GridPoint`, `GridSize`, and `PixelRect`. All pixel geometry is integer maths on
 * the legacy grid, so these port exactly — no narrowing concerns, unlike `Heading`.
 */

export interface GridPoint {
  x: number
  y: number
}

export interface GridSize {
  width: number
  height: number
}

/**
 * Axis-aligned integer rectangle in pixel space. Right and bottom edges are **exclusive**,
 * matching `CollisionMaskOverlap`'s polarity: two rects flush along a far edge do not overlap.
 */
export interface PixelRect {
  x: number
  y: number
  width: number
  height: number
}

export function maxX(rect: PixelRect): number {
  return rect.x + rect.width
}

export function maxY(rect: PixelRect): number {
  return rect.y + rect.height
}

/**
 * Geometric centre. Swift's `x + width / 2` is integer division, so an odd extent truncates
 * toward zero — `Math.trunc` rather than `Math.floor`, which would differ for a negative
 * extent from a malformed sector.
 */
export function rectCenter(rect: PixelRect): { x: number; y: number } {
  return {
    x: rect.x + Math.trunc(rect.width / 2),
    y: rect.y + Math.trunc(rect.height / 2),
  }
}

/** Confines `value` to `[lower, upper]`. */
export function clamp(value: number, lower: number, upper: number): number {
  return Math.min(Math.max(value, lower), upper)
}

export const INT16_MIN = -32_768
export const INT16_MAX = 32_767

/** Swift's `Int16(clamping:)`. */
export function clampToInt16(value: number): number {
  if (Number.isNaN(value)) return 0
  return clamp(Math.trunc(value), INT16_MIN, INT16_MAX)
}
