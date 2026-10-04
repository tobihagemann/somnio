import { describe, expect, it } from 'vitest';
import { angularDistance, heading, headingFromCardinal, headingFromVector, headingRadians, nearestCardinal } from '../src/heading.ts';

describe('headingFromVector preserves the atan2(dx, dz) argument order', () => {
  it.each([
    [0, 1, 0],
    [1, 1, 45],
    [1, 0, 90],
    [0, -1, 180],
    [-1, 0, 270],
    [-1, 1, 315],
  ])('vector (%s, %s) is heading %s', (dx, dz, expected) => {
    expect(headingFromVector(dx, dz)).toBeCloseTo(expected, 9);
  });

  /**
   * Guards the argument order specifically. Conventional `atan2(y, x)` would put 0 degrees on
   * the +dx (east) axis; this convention puts it on +dz (south). A swap mirrors every heading
   * about the 45-degree diagonal, which still produces plausible-looking values.
   */
  it('puts zero degrees on the +dz (south) axis, not +dx', () => {
    expect(headingFromVector(0, 1)).toBe(0);
    expect(headingFromVector(1, 3)).toBeCloseTo(18.43494882292201, 9);
  });
});

describe('heading wraps into [0, 360)', () => {
  it.each([
    [0, 0],
    [360, 0],
    [-0.5, 359.5],
    [720.25, 0.25],
    [-720.25, 359.75],
    [359.96875, 359.96875],
    [137.5, 137.5],
  ])('heading(%s) is %s', (input, expected) => {
    expect(heading(input)).toBe(expected);
  });

  /** A tiny negative rounds `wrapped + 360` back up to exactly 360, so the half-open upper bound has to be re-clamped to 0. */
  it('collapses a tiny negative to 0 rather than leaving it at 360', () => {
    expect(heading(-1e-15)).toBe(0);
  });

  it('collapses a non-finite input to 0 instead of propagating NaN', () => {
    expect(heading(Number.NaN)).toBe(0);
    expect(heading(Number.POSITIVE_INFINITY)).toBe(0);
    expect(heading(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe('angularDistance folds across the seam', () => {
  it.each([
    [359, 1, 2],
    [1, 359, -2],
    [0, 180, -180],
    [180, 0, -180],
    [137.5, 42.25, -95.25],
    [270, 90, -180],
  ])('from %s to %s is %s', (from, to, expected) => {
    expect(angularDistance(from, to)).toBe(expected);
  });

  it('measures the real turn across the 0/360 seam, not the naive difference', () => {
    expect(Math.abs(angularDistance(359, 1))).toBeLessThan(180);
  });
});

describe('headingRadians', () => {
  it.each([
    [0, 0],
    [90, Math.PI / 2],
    [180, Math.PI],
    [270, (3 * Math.PI) / 2],
  ])('heading %s is %s radians', (degrees, expected) => {
    expect(headingRadians(degrees)).toBe(expected);
  });
});

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
    expect(nearestCardinal(degrees)).toBe(expected);
  });

  it('round-trips every cardinal', () => {
    for (const cardinal of ['south', 'east', 'north', 'west'] as const) {
      expect(nearestCardinal(headingFromCardinal(cardinal))).toBe(cardinal);
    }
  });
});
