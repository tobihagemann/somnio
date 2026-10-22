import { describe, expect, it } from 'vitest';
import { bundledModelRegistry, objectModel } from '@somnio/core';
import type { Sector } from '@somnio/core';
import { PROP_LIGHT_POOL_SIZE, flameFlicker, flamePhase } from '@/scene/propLights';
import { splashSectors } from '@/splash/sectors';

/** The pool lights every flame of the room on screen only while no room holds more flames than the pool has lights. */

describe('the committed rooms', () => {
  const registry = bundledModelRegistry();
  const rooms = splashSectors()
    .filter((sector) => sector.kind === 'interior')
    .map((room) => [room.name, room] as const);
  const flamesOf = (room: Sector) => room.placements.filter((placement) => objectModel(registry, placement.modelId)?.light !== undefined);

  it.each(rooms)('light every flame of %s from the pool', (_name, room) => {
    expect(flamesOf(room).length).toBeGreaterThan(0);
    expect(flamesOf(room).length).toBeLessThanOrEqual(PROP_LIGHT_POOL_SIZE);
  });
});

describe('the flicker', () => {
  /** How closely two flames rise and fall together over one whole period of the flicker, from 1 in step to -1 opposed. */
  function correlation(first: number, second: number): number {
    const samples = Array.from({ length: 2000 }, (_, index) => (2 * Math.PI * index) / 2000);
    const swing = (phase: number) => samples.map((seconds) => flameFlicker(seconds, phase) - 1);
    const [a, b] = [swing(first), swing(second)];
    const dot = (x: number[], y: number[]) => x.reduce((sum, value, index) => sum + value * y[index]!, 0);
    return dot(a, b) / Math.sqrt(dot(a, a) * dot(b, b));
  }

  /** Eight flames a step apart, the closest a room's come, correlate at 0.49. */
  it.each(Array.from({ length: PROP_LIGHT_POOL_SIZE - 1 }, (_, index) => index + 2))('keeps every two of %i flames in a room out of step', (count) => {
    for (let first = 0; first < count; first += 1) {
      for (let second = first + 1; second < count; second += 1) {
        expect(correlation(flamePhase(first, count), flamePhase(second, count)), `flames ${first} and ${second}`).toBeLessThan(0.6);
      }
    }
  });
});
