import { clamp } from '@somnio/core';
import type { Point } from '@somnio/core';

/** Every remote entity arrives in the same `moves` batch, so each glides across one batch interval. */
export const REMOTE_INTERPOLATION_SECONDS = 0.1;

interface Motion {
  from: Point;
  to: Point;
  startMs: number;
}

/**
 * Where each remote entity is drawn between two reports from the server.
 *
 * Kept apart from the renderer so "as drawn" is one value: the predictor samples it once a tick,
 * collides the local player against the samples, and writes the same samples to the render
 * surface, so a body blocks exactly where it is seen.
 */
export class RemoteInterpolation {
  private readonly motions = new Map<string, Motion>();

  /** Starts a glide from where the entity is drawn now to a newly reported position. */
  retarget(id: string, from: Point, to: Point, nowMs: number): void {
    this.motions.set(id, { from, to, startMs: nowMs });
  }

  /** `undefined` for an entity that has not moved since it was placed. */
  positionAt(id: string, nowMs: number): Point | undefined {
    const motion = this.motions.get(id);
    if (motion === undefined) return undefined;
    const fraction = clamp((nowMs - motion.startMs) / (REMOTE_INTERPOLATION_SECONDS * 1000), 0, 1);
    return {
      x: motion.from.x + (motion.to.x - motion.from.x) * fraction,
      z: motion.from.z + (motion.to.z - motion.from.z) * fraction,
    };
  }

  delete(id: string): void {
    this.motions.delete(id);
  }

  clear(): void {
    this.motions.clear();
  }
}
