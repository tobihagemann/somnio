import { FLOAT_PI, atan2F32, f32, truncatingRemainderF32 } from './float'

/**
 * Mirror of `Sources/SomnioCore/Models/Heading.swift`. Continuous facing in degrees
 * normalized into `[0, 360)`: zero faces south (+Z, toward the 3/4 camera) and increasing
 * degrees rotate toward east (+X).
 *
 * Represented as a bare number rather than a wrapper object so it costs nothing on the
 * 60 Hz predictor path; the invariant is maintained by constructing only through
 * `heading(...)` / `headingFromVector(...)`.
 */
export type Heading = number

/** The four cardinal facings, mirroring `Direction`. */
export const CARDINAL = { south: 0, east: 90, north: 180, west: 270 } as const
export type Cardinal = keyof typeof CARDINAL

/**
 * Wraps any degree value into `[0, 360)`. There is no invalid raw value to reject, so
 * normalization here is the validation: out-of-range and negative inputs fold in, and a
 * non-finite input collapses to 0 rather than propagating NaN into the transform math.
 */
export function heading(degrees: number): Heading {
  if (!Number.isFinite(degrees)) return 0
  let wrapped = truncatingRemainderF32(degrees, 360)
  if (wrapped < 0) wrapped = f32(wrapped + 360)
  // A tiny negative can round `wrapped + 360` back up to exactly 360; keep the half-open
  // upper bound.
  if (wrapped === 360) wrapped = 0
  return wrapped
}

export function headingFromCardinal(cardinal: Cardinal): Heading {
  return CARDINAL[cardinal]
}

/**
 * The heading of a floor-axis vector (`dx` grows east, `dy` grows south — legacy pixel axes).
 *
 * The argument order is `atan2(dx, dy)`, **not** the conventional `atan2(y, x)`. That is not
 * a transcription slip: it is what makes 0 degrees point south down the +dy axis and rotate
 * toward east. Swapping the arguments produces a heading mirrored about the 45-degree
 * diagonal, which reads as a plausible-but-wrong facing rather than an obvious break.
 */
export function headingFromVector(dx: number, dy: number): Heading {
  const radians = atan2F32(dx, dy)
  const scaled = f32(radians * 180)
  return heading(f32(scaled / FLOAT_PI))
}

/**
 * The yaw about +Y for this heading, in radians.
 *
 * `value` is narrowed before the multiply, not just after. A `Heading` produced by `heading()`
 * is already a `Float` value so the inner narrowing is a no-op there, but a caller passing a
 * raw double (a literal, or a value straight off an input device) would otherwise carry extra
 * mantissa bits into the first product and land one ulp off.
 */
export function headingRadians(value: Heading): number {
  return f32(f32(f32(value) * FLOAT_PI) / 180)
}

/**
 * Quantizes a continuous heading back to a discrete cardinal. Half-open buckets centered on
 * each cardinal, every boundary owned deterministically by the higher bucket (45 -> east,
 * 135 -> north, 225 -> west, 315 -> south) so exact diagonals never straddle.
 */
export function nearestCardinal(value: Heading): Cardinal {
  if (value >= 45 && value < 135) return 'east'
  if (value >= 135 && value < 225) return 'north'
  if (value >= 225 && value < 315) return 'west'
  return 'south'
}

/**
 * Signed shortest-arc delta from `from` to `to`, folded into `[-180, 180]` — so a comparison
 * across the 0/360 seam (359 vs 1) measures the real 2-degree turn rather than a naive 358.
 */
export function angularDistance(from: Heading, to: Heading): number {
  const raw = f32(f32(to) - f32(from))
  const shifted = f32(raw + 540)
  return f32(truncatingRemainderF32(shifted, 360) - 180)
}
