import type { Gait } from '@somnio/protocol';
import { angularDistance } from './heading.ts';
import type { Heading } from './heading.ts';

const METRES_PER_SECOND: Record<Gait, number> = { walk: 1, jog: 2, run: 3 };

export function gaitMetresPerSecond(gait: Gait): number {
  return METRES_PER_SECOND[gait];
}

/**
 * Relative movement direction. A single value drives both the
 * movement clip and the speed penalty, so the clip you see and the speed you move at can never
 * disagree.
 */
export type RelativeDirection = 'forward' | 'backward' | 'strafeLeft' | 'strafeRight';

/**
 * Buckets the signed travel-vs-facing angle: within 45 degrees of facing is forward, beyond 135
 * is backward, and the quarter between is a strafe side. 45 is owned by forward and 135 by
 * strafe.
 */
export function relativeDirection(travel: Heading, facing: Heading): RelativeDirection {
  const signed = angularDistance(facing, travel);
  const magnitude = Math.abs(signed);
  if (magnitude <= 45) return 'forward';
  if (magnitude > 135) return 'backward';
  // Facing the camera (south), a step to screen-east is the character's own left.
  return signed > 0 ? 'strafeLeft' : 'strafeRight';
}

const SPEED_MULTIPLIERS: Record<RelativeDirection, number> = {
  forward: 1.0,
  backward: 0.5,
  strafeLeft: 0.7,
  strafeRight: 0.7,
};

/** Fraction of the same gait's forward speed to travel at. */
export function speedMultiplier(direction: RelativeDirection): number {
  return SPEED_MULTIPLIERS[direction];
}
