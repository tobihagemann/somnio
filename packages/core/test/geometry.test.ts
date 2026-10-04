import { describe, expect, it } from 'vitest';
import { relativeDirection, speedMultiplier } from '../src/gait.ts';
import { EDGE_TOLERANCE, clamp, distance, modelToWorld, rectContains, rectsOverlap, worldToModel } from '../src/geometry.ts';

describe('rects', () => {
  const rect = { x: 2, z: 3, width: 4, depth: 5 };

  it('contain their edges, and their slack', () => {
    expect(rectContains(rect, { x: 2, z: 3 })).toBe(true);
    expect(rectContains(rect, { x: 6, z: 8 })).toBe(true);
    expect(rectContains(rect, { x: 6.01, z: 5 })).toBe(false);
    expect(rectContains(rect, { x: 6.01, z: 5 }, 0.01)).toBe(true);
    expect(rectContains(rect, { x: 4, z: 2.5 }, 0.4)).toBe(false);
  });

  it('overlap only beyond the edge tolerance, so rects that touch do not', () => {
    expect(rectsOverlap(rect, { x: 6, z: 3, width: 4, depth: 5 })).toBe(false);
    expect(rectsOverlap(rect, { x: 6 - EDGE_TOLERANCE / 2, z: 3, width: 4, depth: 5 })).toBe(false);
    expect(rectsOverlap(rect, { x: 5.9, z: 7.9, width: 4, depth: 5 })).toBe(true);
    expect(rectsOverlap(rect, { x: 5.9, z: 8, width: 4, depth: 5 })).toBe(false);
  });
});

describe('the placement transform', () => {
  it('turns a model counter-clockwise seen from above: yaw 270 points its +X south', () => {
    const south = modelToWorld({ x: 10, z: 20, yaw: 270 }, { x: 1, z: 0 });
    expect(south.x).toBeCloseTo(10, 9);
    expect(south.z).toBeCloseTo(21, 9);
    const north = modelToWorld({ x: 10, z: 20, yaw: 90 }, { x: 1, z: 0 });
    expect(north.x).toBeCloseTo(10, 9);
    expect(north.z).toBeCloseTo(19, 9);
  });

  it.each([0, 30, 90, 137.5, 270])('inverts at yaw %s', (yaw) => {
    const transform = { x: 3, z: -7, yaw };
    const back = worldToModel(transform, modelToWorld(transform, { x: 1.25, z: -0.5 }));
    expect(back.x).toBeCloseTo(1.25, 9);
    expect(back.z).toBeCloseTo(-0.5, 9);
  });
});

describe('scalar helpers', () => {
  it('measure distance on the ground plane', () => {
    expect(distance({ x: 1, z: 1 }, { x: 4, z: 5 })).toBe(5);
  });

  it('clamp into a range', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-5, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
  });
});

describe('gait and relative direction', () => {
  it.each([
    [0, 0, 'forward'],
    [45, 0, 'forward'],
    [46, 0, 'strafeLeft'],
    [135, 0, 'strafeLeft'],
    [136, 0, 'backward'],
    [180, 0, 'backward'],
    [270, 0, 'strafeRight'],
    // A -45 degree arc is still within the forward bucket, so this is not a strafe.
    [315, 0, 'forward'],
  ])('travel %s against facing %s is %s', (travel, facing, expected) => {
    expect(relativeDirection(travel, facing)).toBe(expected);
  });

  it('owns 45 by forward and 135 by strafe', () => {
    expect(relativeDirection(45, 0)).toBe('forward');
    expect(relativeDirection(135, 0)).toBe('strafeLeft');
  });

  it('applies the speed penalty per direction', () => {
    expect(speedMultiplier('forward')).toBe(1.0);
    expect(speedMultiplier('backward')).toBe(0.5);
    expect(speedMultiplier('strafeLeft')).toBe(0.7);
    expect(speedMultiplier('strafeRight')).toBe(0.7);
  });
});
