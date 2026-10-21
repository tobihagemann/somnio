import { describe, expect, it } from 'vitest';
import { GrassSpring } from '@/scene/grassSpring';
import type { GrassBatch, GrassContact } from '@/scene/grassSpring';

/** Grass leaning under a body's feet and springing back once let go, frame by frame. */

const FRAME = 1 / 60;

function tuft(x = 5, z = 5): { spring: GrassSpring; batch: GrassBatch } {
  const spring = new GrassSpring();
  const batch = { roots: new Float32Array([x, z]), halfWidths: new Float32Array([0.07]), tilts: new Float32Array(2) };
  spring.add(batch);
  return { spring, batch };
}

function run(spring: GrassSpring, contacts: readonly GrassContact[], seconds: number): void {
  for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += FRAME) spring.step(contacts, FRAME);
}

const tilt = (batch: GrassBatch): number => Math.hypot(batch.tilts[0]!, batch.tilts[1]!);

describe('the grass spring', () => {
  it('leaves a tuft no contact touches upright', () => {
    const { spring, batch } = tuft();
    run(spring, [{ x: 6, z: 5, radius: 0.06 }], 0.5);
    expect(tilt(batch)).toBe(0);
  });

  it('leans a tuft away from a foot 2 cm off its root, past half a radian within 0.15 s', () => {
    const { spring, batch } = tuft();
    run(spring, [{ x: 4.98, z: 5, radius: 0.06 }], 0.15);
    expect(tilt(batch)).toBeGreaterThan(0.5);
    expect(batch.tilts[0]).toBeGreaterThan(0);
    expect(Math.abs(batch.tilts[1]!)).toBeLessThan(1e-6);
  });

  it('leans a tuft its own way when the contact stands right on its root', () => {
    const first = tuft(5, 5);
    const second = tuft(7.3, 2.1);
    run(first.spring, [{ x: 5, z: 5, radius: 0.06 }], 0.3);
    run(second.spring, [{ x: 7.3, z: 2.1, radius: 0.06 }], 0.3);
    expect(tilt(first.batch)).toBeGreaterThan(0.5);
    expect(Math.atan2(first.batch.tilts[1]!, first.batch.tilts[0]!)).not.toBeCloseTo(Math.atan2(second.batch.tilts[1]!, second.batch.tilts[0]!), 3);
  });

  it('springs back below 0.1 rad between 0.8 and 1.4 s after the contact leaves', () => {
    const { spring, batch } = tuft();
    run(spring, [{ x: 4.98, z: 5, radius: 0.06 }], 0.5);
    let seconds = 0;
    while (tilt(batch) >= 0.1 && seconds < 3) {
      spring.step([], FRAME);
      seconds += FRAME;
    }
    expect(seconds).toBeGreaterThan(0.8);
    expect(seconds).toBeLessThan(1.4);
  });

  it('reports a batch changed only while one of its tufts moves', () => {
    const { spring, batch } = tuft();
    expect(spring.step([], FRAME).size).toBe(0);
    expect(spring.step([{ x: 4.98, z: 5, radius: 0.06 }], FRAME).has(batch)).toBe(true);
  });

  it('keeps a tuft springing back when another batch is removed', () => {
    const { spring, batch } = tuft();
    const other = { roots: new Float32Array([9, 9]), halfWidths: new Float32Array([0.07]), tilts: new Float32Array(2) };
    spring.add(other);
    run(spring, [{ x: 4.98, z: 5, radius: 0.06 }], 0.5);
    expect(tilt(batch)).toBeGreaterThan(0.5);

    spring.remove(other);
    run(spring, [], 3);

    expect(tilt(batch)).toBeLessThan(0.01);
  });
});
