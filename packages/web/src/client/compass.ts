import { headingFromVector } from '@somnio/core';
import type { Point } from '@somnio/core';

/** The eight directions a voice is named by, in heading order: one every 45 degrees from south. */
export const COMPASS_POINTS = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'] as const;
export type CompassPoint = (typeof COMPASS_POINTS)[number];

/** The nearest of the eight directions from one point toward another; `undefined` when they lie too close for a bearing. */
export function compassPoint(from: Point, to: Point): CompassPoint | undefined {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (Math.hypot(dx, dz) < 0.1) return undefined;
  return COMPASS_POINTS[Math.round(headingFromVector(dx, dz) / 45) % COMPASS_POINTS.length];
}
