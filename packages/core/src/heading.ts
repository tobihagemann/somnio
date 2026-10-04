/**
 * The heading model. Continuous facing in degrees
 * normalized into `[0, 360)`: zero faces south (+Z, toward the 3/4 camera) and increasing
 * degrees rotate toward east (+X).
 *
 * Represented as a bare number rather than a wrapper object so it costs nothing on the
 * 60 Hz predictor path; the invariant is maintained by constructing only through
 * `heading(...)` / `headingFromVector(...)`.
 */
export type Heading = number;

/** The four cardinal facings in degrees. */
export const CARDINAL = { south: 0, east: 90, north: 180, west: 270 } as const;
export type Cardinal = keyof typeof CARDINAL;

/**
 * Wraps any degree value into `[0, 360)`. There is no invalid raw value to reject, so
 * normalization here is the validation: out-of-range and negative inputs fold in, and a
 * non-finite input collapses to 0 rather than propagating NaN into the transform math.
 */
export function heading(degrees: number): Heading {
  if (!Number.isFinite(degrees)) return 0;
  let wrapped = degrees % 360;
  if (wrapped < 0) wrapped += 360;
  // A tiny negative can round `wrapped + 360` back up to exactly 360; keep the half-open
  // upper bound.
  if (wrapped === 360) wrapped = 0;
  return wrapped;
}

export function headingFromCardinal(cardinal: Cardinal): Heading {
  return CARDINAL[cardinal];
}

/**
 * The heading of a ground-plane vector (`dx` grows east, `dz` grows south).
 *
 * The argument order is `atan2(dx, dz)`, **not** the conventional `atan2(y, x)`. That is not
 * a transcription slip: it is what makes 0 degrees point south down the +dz axis and rotate
 * toward east. Swapping the arguments produces a heading mirrored about the 45-degree
 * diagonal, which reads as a plausible-but-wrong facing rather than an obvious break.
 */
export function headingFromVector(dx: number, dz: number): Heading {
  return heading((Math.atan2(dx, dz) * 180) / Math.PI);
}

/** The yaw about +Y for this heading, in radians. */
export function headingRadians(value: Heading): number {
  return (value * Math.PI) / 180;
}

/**
 * Quantizes a continuous heading back to a discrete cardinal. Half-open buckets centered on
 * each cardinal, every boundary owned deterministically by the higher bucket (45 -> east,
 * 135 -> north, 225 -> west, 315 -> south) so exact diagonals never straddle.
 */
export function nearestCardinal(value: Heading): Cardinal {
  if (value >= 45 && value < 135) return 'east';
  if (value >= 135 && value < 225) return 'north';
  if (value >= 225 && value < 315) return 'west';
  return 'south';
}

/**
 * Signed shortest-arc delta from `from` to `to`, folded into `[-180, 180)` — so a comparison
 * across the 0/360 seam (359 vs 1) measures the real 2-degree turn rather than a naive 358.
 */
export function angularDistance(from: Heading, to: Heading): number {
  return ((to - from + 540) % 360) - 180;
}
