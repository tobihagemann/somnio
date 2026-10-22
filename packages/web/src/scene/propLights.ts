/**
 * The light a room's hearth, lamps, candles, and torches give: a warm pool round each flame and a halo on
 * it. The pool is a fixed set of point lights, so the number of lights in the scene, and with it
 * every shader program, stays the same whatever room is drawn.
 */
import type { LightKind } from '@somnio/core';

/** How many flames one room lights. A flame past this draws its halo but lights nothing. */
export const PROP_LIGHT_POOL_SIZE = 8;

export const PROP_LIGHT_COLOR = 0xffa24f;
/** How far a flame's pool reaches, in metres, and how it falls off over that reach. */
export const PROP_LIGHT_DISTANCE = 4.2;
export const PROP_LIGHT_DECAY = 1.4;

/** Each kind's pool intensity, in three.js units, and the size of its halo, in metres. */
export const PROP_LIGHT_PRESETS: Record<LightKind, { intensity: number; halo: number }> = {
  candle: { intensity: 1.3, halo: 0.35 },
  hearth: { intensity: 3.2, halo: 0.75 },
  lamp: { intensity: 1.6, halo: 0.4 },
  torch: { intensity: 2.4, halo: 0.55 },
};

/** A flame's brightness factor at a moment, within 10% of 1, its swell and ripple shifted by `phase`. */
export function flameFlicker(seconds: number, phase: number): number {
  return 1 + 0.06 * Math.sin(seconds * 11 + phase) + 0.04 * Math.sin(seconds * 27 + 2 * phase);
}

/**
 * The phase of the flame at `index` among a room's `count` flames. The phases are spread evenly round
 * the circle, so no two of a room's flames swell together while it holds no more than the pool lights.
 */
export function flamePhase(index: number, count: number): number {
  return (2 * Math.PI * index) / count;
}
