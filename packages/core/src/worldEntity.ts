import { clampToInt16 } from './geometry.ts';
import type { GridPoint, GridSize } from './geometry.ts';
import type { Heading } from './heading.ts';
import type { Tempo } from './tempo.ts';

export type WorldEntityKind = 'player' | 'peer' | 'npc' | 'monster';

export interface WorldEntity {
  id: number;
  kind: WorldEntityKind;
  figure: number;
  gender: number;
  position: GridPoint;
  facing: Heading;
  tempo: Tempo;
  maskSize: GridSize;
  name: string;
}

/** Sub-pixel position on the legacy pixel grid. */
export interface SubpixelPoint {
  x: number;
  y: number;
}

/** The one rule for collapsing a sub-pixel render position back onto the simulation grid. */
export function gridRounded(point: SubpixelPoint): GridPoint {
  return { x: clampRound(point.x), y: clampRound(point.y) };
}

/**
 * Exported because it is the one rule for the half-away-from-zero convention: `Math.round` rounds
 * half toward +infinity, so a negative .5 lands on the wrong neighbour, and every site that
 * collapses a sub-pixel coordinate has to agree.
 */
export function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** Rounds half away from zero, then clamps to the Int16 range. */
function clampRound(value: number): number {
  return clampToInt16(roundHalfAwayFromZero(value));
}
