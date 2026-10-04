import { describe, expect, it } from 'vitest';
import { objectModel } from '@somnio/core';
import {
  MIN_SCALE,
  ORTHO_RIG,
  PLAYER_ZOOM,
  applyScrollZoom,
  cameraPosition,
  clampedScale,
  frustumBounds,
  offsetDirection,
  scaleForZoomFactor,
  worldMovement,
} from '@/scene/cameraRig';
import { yawStep } from '@/scene/yawSlew';
import { CHARACTER_SCALE, easedHeight, floorUVRect, placeholderFootprint, placementElevation } from '@/scene/placement';
import { TEST_REGISTRY } from '../../core/test/support/worldFixture.ts';

describe('orthographic scale is a HALF-height', () => {
  /**
   * The single most consequential mapping in the renderer. `scale` is the vertical half-height —
   * the render spans `2 x scale` metres — so `top/bottom = +/-scale`. Three.js examples almost
   * always show `frustumSize / 2`, and applying that idiom here halves an already-halved value
   * and renders the whole world at 2x magnification.
   */
  it('maps scale directly to top and bottom, not scale/2', () => {
    const bounds = frustumBounds(3, 1);
    expect(bounds.top).toBe(3);
    expect(bounds.bottom).toBe(-3);
    expect(bounds.top).not.toBe(1.5);
  });

  it('spans 2 x scale metres vertically', () => {
    const bounds = frustumBounds(3, 1.5);
    expect(bounds.top - bounds.bottom).toBe(6);
  });

  it('lets aspect drive width while the vertical extent stays fixed', () => {
    const wide = frustumBounds(3, 2);
    const tall = frustumBounds(3, 0.5);
    // MMO fairness: every window size shows the same vertical world extent, so a bigger window
    // magnifies rather than reveals.
    expect(wide.top - wide.bottom).toBe(tall.top - tall.bottom);
    expect(wide.right - wide.left).toBe(12);
    expect(tall.right - tall.left).toBe(3);
  });
});

describe('rig constants and derived bounds', () => {
  it('derives minScale from the zoom clamp so the two agree by construction', () => {
    expect(MIN_SCALE).toBe(1.5);
  });

  it('clamps scale into the interactive range', () => {
    expect(clampedScale(0.1)).toBe(MIN_SCALE);
    expect(clampedScale(100)).toBe(ORTHO_RIG.maxScale);
    expect(clampedScale(3)).toBe(3);
  });

  it('inverts the zoom factor into a camera scale', () => {
    expect(scaleForZoomFactor(1)).toBe(3);
    expect(scaleForZoomFactor(2)).toBe(1.5);
    expect(scaleForZoomFactor(0.5)).toBe(6);
  });
});

describe('offsetDirection', () => {
  it('is the pitch/yaw unit vector', () => {
    const direction = offsetDirection();
    expect(direction.x).toBeCloseTo(0.40557978767263897, 12);
    expect(direction.y).toBeCloseTo(0.7071067811865476, 12);
    expect(direction.z).toBeCloseTo(0.5792279653395692, 12);
    expect(Math.hypot(direction.x, direction.y, direction.z)).toBeCloseTo(1, 12);
  });

  it('places the camera back along that direction', () => {
    const position = cameraPosition({ x: 2, y: 1, z: -3 });
    expect(position.x).toBeCloseTo(2 + 0.40557978767263897 * ORTHO_RIG.cameraDistance, 9);
    expect(position.y).toBeCloseTo(1 + 0.7071067811865476 * ORTHO_RIG.cameraDistance, 9);
    expect(position.z).toBeCloseTo(-3 + 0.5792279653395692 * ORTHO_RIG.cameraDistance, 9);
  });
});

describe('worldMovement rotates WASD through the camera yaw', () => {
  it.each([
    [1, 0, 0.8191520442889918, -0.573576436351046],
    [0, -1, -0.573576436351046, -0.8191520442889918],
    [0, 1, 0.573576436351046, 0.8191520442889918],
    [-1, 0, -0.8191520442889918, 0.573576436351046],
    [0.6, 0.8, 0.9503523756542319, 0.31117577362056587],
  ])('screen (%s, %s) becomes world (%s, %s)', (dx, dy, wx, wz) => {
    const moved = worldMovement(dx, dy);
    expect(moved.dx).toBe(wx);
    expect(moved.dz).toBe(wz);
  });

  it('is a pure rotation, so a unit input stays unit length', () => {
    const moved = worldMovement(0.7071067811865476, -0.7071067811865476);
    expect(Math.hypot(moved.dx, moved.dz)).toBeCloseTo(1, 12);
  });

  it('walks up-screen away from the viewer rather than along world north', () => {
    const up = worldMovement(0, -1);
    expect(up.dx).toBeLessThan(0);
    expect(up.dz).toBeLessThan(0);
  });
});

describe('yawStep takes the shortest arc', () => {
  /** One 60 Hz frame of the quarter-turn-in-0.175-s rate. */
  const STEP = (Math.PI / 2 / 0.175) * 0.0166667;

  it.each([
    [0, Math.PI / 2, STEP],
    // Across the +/-pi seam the short way, not back through zero, wrapping as it crosses.
    [3.0, -3.0, 3.0 + STEP - 2 * Math.PI],
    [0, 0.001, 0.001],
    [1.0, 1.0, 1.0],
  ])('from %s toward %s is %s', (current, target, expected) => {
    expect(yawStep(current, target, 0.0166667)).toBeCloseTo(expected, 12);
  });

  /**
   * The exact-180-degree case. The remainder rounds the quotient to nearest rather than
   * truncating, so this resolves to one consistent turn direction; with `%` the entity
   * oscillates instead of turning.
   */
  it('resolves an exact half-turn to one consistent direction', () => {
    const first = yawStep(0, Math.PI, 0.0166667);
    const second = yawStep(first, Math.PI, 0.0166667);

    expect(first).toBeCloseTo(-STEP, 12);
    expect(second).toBeCloseTo(-2 * STEP, 12);
    expect(yawStep(0, -Math.PI, 0.0166667)).toBe(first);
  });

  it('snaps to the target rather than overshooting when the step covers the delta', () => {
    expect(yawStep(0, 0.001, 1)).toBe(0.001);
  });

  it('completes a quarter turn in 0.175 s', () => {
    expect(yawStep(0, Math.PI / 2, 0.175)).toBeCloseTo(Math.PI / 2, 12);
  });
});

describe('character scale', () => {
  it('is the one constant every character model gets', () => {
    expect(CHARACTER_SCALE).toBe(0.74);
  });
});

describe('placement elevation', () => {
  const placement = { id: 'p', modelId: 'rug', x: 1, z: 2, yaw: 0, elevation: 0.5 };

  it('lifts a model that has no walk surfaces', () => {
    expect(placementElevation(placement, objectModel(TEST_REGISTRY, 'rug'))).toBe(0.5);
  });

  /** Bodies walk on those surfaces and collision never lifts them, so the drawn model must not either. */
  it('keeps a model with walk surfaces on the ground whatever its record says', () => {
    expect(placementElevation({ ...placement, modelId: 'dais' }, objectModel(TEST_REGISTRY, 'dais'))).toBe(0);
  });

  it('lifts a model the registry does not know', () => {
    expect(placementElevation({ ...placement, modelId: 'unmapped' }, undefined)).toBe(0.5);
  });
});

describe('placeholder footprint', () => {
  it('is the registry footprint for a model whose mesh has not loaded', () => {
    expect(placeholderFootprint(objectModel(TEST_REGISTRY, 'box'))).toEqual({ width: 2, depth: 1 });
  });

  it('is a small box for a model the registry does not know', () => {
    expect(placeholderFootprint(undefined)).toEqual({ width: 0.64, depth: 0.64 });
  });
});

describe('eased height', () => {
  it('closes on the ground with an 80 ms time constant', () => {
    // After one time constant the gap is down to 1/e of what it was.
    expect(easedHeight(0, 1, 0.08)).toBeCloseTo(1 - 1 / Math.E, 12);
    expect(easedHeight(1, 0, 0.08)).toBeCloseTo(1 / Math.E, 12);
  });

  it('snaps onto the ground once within a millimetre', () => {
    expect(easedHeight(0.2495, 0.25, 0.001)).toBe(0.25);
    expect(easedHeight(0.24, 0.25, 0.001)).toBeLessThan(0.25);
  });

  it('stays put on a frame with no time in it', () => {
    expect(easedHeight(0.5, 1, 0)).toBe(0.5);
  });
});

describe('floor UVs are in space coordinates', () => {
  it.each([
    [0, 0, 1.6, 1.6, 1, 0, 0, 1, 1],
    [1.6, 0, 3.2, 1.6, 1, 1, 0, 2, 1],
    [8, -4.8, 1.6, 3.2, 1, 5, -3, 1, 2],
  ])('rect (%s, %s, %s, %s) at aspect %s', (x, z, width, depth, aspect, originX, originY, spanX, spanY) => {
    const uv = floorUVRect({ x, z, width, depth }, aspect);
    expect(uv.origin.x).toBeCloseTo(originX, 12);
    expect(uv.origin.y).toBeCloseTo(originY, 12);
    expect(uv.span.x).toBeCloseTo(spanX, 12);
    expect(uv.span.y).toBeCloseTo(spanY, 12);
  });

  /**
   * The continuity contract, asserted directly: abutting same-material rects must share their
   * edge UVs, or the texture phase resets at every seam and a cobbled street visibly tile-breaks
   * at each rect boundary. It holds across a sector border too, because the rects are in space
   * coordinates: these two are a sector's east edge and its neighbour's west edge.
   */
  it('makes one rect end where its neighbour begins', () => {
    const left = floorUVRect({ x: 0, z: 0, width: 40.96, depth: 40.96 }, 1);
    const right = floorUVRect({ x: 40.96, z: 0, width: 30.72, depth: 30.72 }, 1);
    expect(left.origin.x + left.span.x).toBeCloseTo(right.origin.x, 12);
  });

  it('shrinks the V repeat for a non-square texture', () => {
    const square = floorUVRect({ x: 0, z: 0, width: 2.56, depth: 2.56 }, 1);
    const strip = floorUVRect({ x: 0, z: 0, width: 2.56, depth: 2.56 }, 0.5);
    expect(strip.span.y).toBeCloseTo(square.span.y * 2, 12);
    expect(strip.span.x).toBe(square.span.x);
  });
});

describe('scroll zoom', () => {
  it('clamps to the factor range', () => {
    expect(applyScrollZoom(1, 10_000)).toBe(2);
    expect(applyScrollZoom(1, -10_000)).toBe(0.5);
  });

  it('moves the same fraction at either clamp end', () => {
    const fromLow = applyScrollZoom(0.6, 10) / 0.6;
    const fromHigh = applyScrollZoom(1.2, 10) / 1.2;
    expect(fromLow).toBeCloseTo(fromHigh, 10);
  });
});

describe('rig constants', () => {
  /**
   * The rig and zoom constants as literals. `cameraRig.ts` and `input.ts` are the only
   * implementation, so these pins guard against an accidental retune rather than a mirror drift:
   * changing one moves the framing of the whole world the moment it lands.
   */
  it.each([
    ['pitchDegrees', ORTHO_RIG.pitchDegrees, 45],
    ['yawDegrees', ORTHO_RIG.yawDegrees, 35],
    ['cameraDistance', ORTHO_RIG.cameraDistance, 50],
    ['defaultScale', ORTHO_RIG.defaultScale, 3],
    ['maxScale', ORTHO_RIG.maxScale, 24],
    ['nearClip', ORTHO_RIG.nearClip, 0.05],
    ['farClip', ORTHO_RIG.farClip, 500],
  ])('pins %s', (_name, value, expected) => {
    expect(value).toBe(expected);
  });

  it.each([
    ['minFactor', PLAYER_ZOOM.minFactor, 0.5],
    ['maxFactor', PLAYER_ZOOM.maxFactor, 2.0],
    ['scrollGain', PLAYER_ZOOM.scrollGain, 0.015],
  ])('pins PlayerZoom %s', (_name, value, expected) => {
    expect(value).toBe(expected);
  });
});
