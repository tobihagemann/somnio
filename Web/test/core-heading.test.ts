import { describe, expect, it } from 'vitest'
import {
  angularDistance,
  heading,
  headingFromCardinal,
  headingFromVector,
  headingRadians,
  nearestCardinal,
} from '@/core/heading'
import { FLOAT_PI, f32, ieeeRemainderF32 } from '@/core/float'

/**
 * Cross-language pins for `Sources/SomnioCore/Models/Heading.swift`.
 *
 * Every expectation below was produced by compiling and running the Swift arithmetic itself,
 * not re-derived in JavaScript, and every case is one where binary32 and binary64 actually
 * disagree. That matters because the wire-pinned headings `[0.0, 137.5, 359.96875]` are all
 * exactly representable in *both* precisions, so a round-trip through them passes with or
 * without `Math.fround` — it cannot guard the narrowing. Those values are covered as a
 * wire-parity check in the codec suite; these guard the arithmetic.
 *
 * If any of these regress, the cause is almost always a dropped `f32` on an intermediate
 * step rather than a wrong formula.
 */

describe('FLOAT_PI matches Swift, not fround', () => {
  /**
   * Swift rounds `FloatingPoint.pi` toward zero; `Math.fround` rounds to nearest, which for pi
   * rounds up to the adjacent Float. Every heading and yaw conversion divides by this
   * constant, so getting it wrong is a one-ulp systematic error across the whole port rather
   * than an isolated rounding difference.
   */
  it('is the round-toward-zero value', () => {
    expect(FLOAT_PI).toBe(3.141592502593994)
    expect(FLOAT_PI).not.toBe(Math.fround(Math.PI))
    expect(FLOAT_PI).toBeLessThan(Math.PI)
  })

  it('is exactly representable in binary32', () => {
    expect(Math.fround(FLOAT_PI)).toBe(FLOAT_PI)
  })
})

describe('headingFromVector preserves the atan2(dx, dy) argument order', () => {
  it.each([
    [1, 3, 18.43494987487793],
    [1, 1, 45.000003814697266],
    [-1, 3, 341.5650634765625],
    [3, -7, 156.80140686035156],
    [0.5, 0.25, 63.43495178222656],
    [-2, -5, 201.80140686035156],
    [7, 11, 32.47119140625],
    [1, 0, 90.00000762939453],
    [0, 1, 0],
    [0, -1, 180],
    [-1, 0, 270],
  ])('vector (%s, %s) is heading %s', (dx, dy, expected) => {
    expect(headingFromVector(dx, dy)).toBe(expected)
  })

  /**
   * The antipodal case is the one place `atan2f` and a narrowed binary64 `Math.atan2` diverge:
   * `atan2f` saturates at `Float.pi` (toward zero) while narrowing rounds to nearest and
   * overshoots by an ulp. `atan2F32` clamps to the range for exactly this reason, so a
   * regression here means that clamp was removed.
   */
  it('lands exactly on 180 for the antipodal vector', () => {
    expect(headingFromVector(0, -1)).toBe(180)
  })

  /**
   * Guards the argument order specifically. Conventional `atan2(y, x)` would put 0 degrees on
   * the +dx (east) axis; this convention puts it on +dy (south). A swap mirrors every heading
   * about the 45-degree diagonal, which still produces plausible-looking values.
   */
  it('puts zero degrees on the +dy (south) axis, not +dx', () => {
    expect(headingFromVector(0, 1)).toBe(0)
    expect(headingFromVector(1, 0)).toBeCloseTo(90, 4)
  })
})

describe('heading wraps into [0, 360) at single precision', () => {
  it.each([
    [0, 0],
    [360, 0],
    [-0.5, 359.5],
    [720.25, 0.25],
    [-720.25, 359.75],
    [359.96875, 359.96875],
    [137.5, 137.5],
    [1e-8, 9.99999993922529e-9],
    [45.7, 45.70000076293945],
    [1234.5678, 154.5677490234375],
    [-1234.5678, 205.4322509765625],
  ])('heading(%s) is %s', (input, expected) => {
    expect(heading(input)).toBe(expected)
  })

  /**
   * The documented edge case: a tiny negative rounds `wrapped + 360` back up to exactly 360
   * in binary32, so the half-open upper bound has to be re-clamped to 0. In binary64 the same
   * input lands on 359.99999999, so this case only exists once the narrowing is in place.
   */
  it('collapses a tiny negative to 0 rather than leaving it at 360', () => {
    expect(heading(-1e-8)).toBe(0)
  })

  it('collapses a non-finite input to 0 instead of propagating NaN', () => {
    expect(heading(Number.NaN)).toBe(0)
    expect(heading(Number.POSITIVE_INFINITY)).toBe(0)
    expect(heading(Number.NEGATIVE_INFINITY)).toBe(0)
  })
})

describe('angularDistance folds across the seam at single precision', () => {
  it.each([
    [359, 1, 2],
    [1, 359, -2],
    [0, 180, -180],
    [180, 0, -180],
    [137.5, 42.25, -95.25],
    [0.1, 359.9, -0.20001220703125],
    [270, 90, -180],
    [33.3, 66.6, 33.29998779296875],
  ])('from %s to %s is %s', (from, to, expected) => {
    expect(angularDistance(from, to)).toBe(expected)
  })

  it('measures the real turn across the 0/360 seam, not the naive difference', () => {
    expect(Math.abs(angularDistance(359, 1))).toBeLessThan(180)
  })
})

describe('headingRadians', () => {
  it.each([
    [0, 0],
    [90, 1.570796251296997],
    [137.5, 2.399827480316162],
    [270, 4.71238899230957],
    [359.96875, 6.282639503479004],
    [45.7, 0.7976154685020447],
  ])('heading %s is %s radians', (degrees, expected) => {
    expect(headingRadians(degrees)).toBe(expected)
  })

  it('differs from the binary64 result, which is what the narrowing exists to prevent', () => {
    expect(headingRadians(90)).not.toBe(Math.PI / 2)
  })
})

describe('nearestCardinal owns every boundary by the higher bucket', () => {
  it.each([
    [0, 'south'],
    [44.9, 'south'],
    [45, 'east'],
    [134.9, 'east'],
    [135, 'north'],
    [224.9, 'north'],
    [225, 'west'],
    [314.9, 'west'],
    [315, 'south'],
    [359.9, 'south'],
  ])('heading %s quantizes to %s', (degrees, expected) => {
    expect(nearestCardinal(degrees)).toBe(expected)
  })

  it('round-trips every cardinal', () => {
    for (const cardinal of ['south', 'east', 'north', 'west'] as const) {
      expect(nearestCardinal(headingFromCardinal(cardinal))).toBe(cardinal)
    }
  })
})

/**
 * The round-half-to-even tie correction in `ieeeRemainderF32`.
 *
 * Reachable from ordinary gameplay, not just in theory: `headingRadians(180)` is exactly `FLOAT_PI`
 * and `f32(2 * FLOAT_PI)` is exactly twice it, so the quotient is exactly 0.5 with an odd
 * `Math.round` — the one input shape the correction exists for. `scene-rig.test.ts`'s half-turn case
 * cannot cover it: it passes `Math.fround(Math.PI)`, whose quotient is 0.5000000379, the non-tie
 * path, and which yields the same answer with or without the correction.
 *
 * Getting it wrong flips the sign of the shortest arc, so the yaw slew turns the long way round.
 */
describe('ieeeRemainderF32 handles the exact-half tie', () => {
  it('resolves an exact half-turn toward positive pi, matching Swift', () => {
    const target = headingRadians(180)
    expect(target).toBe(FLOAT_PI)

    const delta = ieeeRemainderF32(f32(target - 0), f32(2 * FLOAT_PI))

    // Swift's `remainder(dividingBy:)` rounds the quotient half-to-even: 0.5 rounds to 0, not 1,
    // so the remainder stays +pi rather than flipping to -pi.
    expect(delta).toBe(FLOAT_PI)
    expect(Object.is(delta, -FLOAT_PI)).toBe(false)
  })

  /**
   * The negative half of the same tie, which the positive case alone cannot see.
   *
   * `Math.round` breaks every tie toward +Infinity, so the even neighbour is the value *below* for
   * both signs — correcting by the quotient's sign instead of by one moves a negative tie the wrong
   * way and returns a remainder outside the range this function promises. Today's only caller keeps
   * its quotients inside (-1.5, 1.5), so this pins the primitive rather than a reachable bug.
   */
  it.each([
    [-3, 2, 1],
    [3, 2, -1],
    [-5, 2, -1],
    [5, 2, 1],
  ])('resolves ieeeRemainderF32(%i, %i) to %i as Swift does', (value, divisor, expected) => {
    expect(ieeeRemainderF32(value, divisor)).toBe(expected)
  })
})
