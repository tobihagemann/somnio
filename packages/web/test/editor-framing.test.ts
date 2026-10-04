import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ORTHO_RIG, PLAYER_ZOOM } from '@/scene/cameraRig';
import {
  EditorCamera,
  applyFramingToCamera,
  editorFramingFitting,
  editorFramingFittingBounds,
  fitBounds,
  playerZoomScale,
  scrollIntent,
} from '@/editor/framing';
import type { EditorFraming } from '@/editor/framing';
import { gridPoint, screenPoint } from '@/editor/canvasController';
import { floorPointAtScreen, screenAtFloorPoint } from '@/editor/picking';
import type { ViewportSize } from '@/editor/picking';
import { readSectorFile } from '@somnio/core';
import type { Sector } from '@somnio/core';
import { SECTOR_FIXTURE_NAMES, readSectorFixture } from '../../core/test/support/sectorFixture.ts';
import { outdoorSector } from '../../core/test/support/worldFixture.ts';
import { VIEWPORT, dragContext } from './helpers/editorFixture';

/**
 * The camera math: the project→unproject round trip, the whole-sector fit, the fit's
 * independence from the gameplay zoom clamp, the player-zoom opening framing, pan/zoom,
 * custom-camera persistence, and the scroll-intent cases. The unprojection here is the live Raycaster
 * against the camera the framing was applied to, so these also pin that the Three.js
 * projection agrees with the analytic fit math.
 */

function cameraFor(framing: EditorFraming, viewport: ViewportSize = VIEWPORT): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera();
  applyFramingToCamera(camera, framing, viewport);
  return camera;
}

function testSector(overrides: Partial<Sector> = {}): Sector {
  return outdoorSector('Test', { x: 0, z: 0 }, { size: { width: 30, depth: 30 }, ...overrides });
}

describe('gridPoint', () => {
  it.each([
    [
      { x: 0, z: 0 },
      { x: 2.56, z: 1.92 },
    ],
    [
      { x: 5.12, z: -30.72 },
      { x: 2.56, z: 1.92 },
    ],
    // Past the sector's north-west corner the point is negative, not clamped.
    [
      { x: 5.12, z: -30.72 },
      { x: -0.5, z: -1.25 },
    ],
  ])('for a sector at %o resolves a tap on %o to that sector-relative point', (origin, point) => {
    const context = dragContext(0.5, origin);
    expect(gridPoint(context, screenPoint(context, point))).toEqual(point);
  });

  it('rounds to the millimetre', () => {
    const context = dragContext();
    expect(gridPoint(context, screenPoint(context, { x: 2.00049, z: 3.99951 }))).toEqual({ x: 2, z: 4 });
  });
});

describe('project then unproject', () => {
  const framing = editorFramingFittingBounds({ x: 0, z: 0 }, { x: 20, z: 20 }, VIEWPORT);
  const camera = cameraFor(framing);

  it.each([
    [0, 0],
    [2.57, 1.93],
    [19.99, 19.99],
    [-1.28, -0.96],
    [5.12, -30.72],
  ])('returns the same ground point for (%s, %s)', (x, z) => {
    const restored = floorPointAtScreen(camera, VIEWPORT, screenAtFloorPoint(camera, VIEWPORT, { x, z }));
    expect(Math.hypot(restored.x - x, restored.z - z)).toBeLessThan(1e-6);
  });

  it('unprojects the viewport center to the framed bounds center', () => {
    const center = floorPointAtScreen(camera, VIEWPORT, { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 });
    expect(Math.hypot(center.x - 10, center.z - 10)).toBeLessThan(1e-6);
  });
});

describe('whole-sector fit', () => {
  /** Extreme aspects alongside the play-field default. */
  const viewports: ViewportSize[] = [
    { width: 640, height: 480 },
    { width: 1600, height: 400 },
    { width: 400, height: 1200 },
  ];

  it.each(SECTOR_FIXTURE_NAMES.flatMap((name) => viewports.map((viewport) => [name, viewport] as const)))(
    "%s's floor and placements project inside a %o viewport",
    (name, viewport) => {
      const sector = readSectorFile(readSectorFixture(name), name);
      const camera = cameraFor(editorFramingFitting(sector, viewport), viewport);
      const bounds = fitBounds(sector);
      const origin = sector.origin ?? { x: 0, z: 0 };
      const corners = [bounds.min, { x: bounds.max.x, z: bounds.min.z }, { x: bounds.min.x, z: bounds.max.z }, bounds.max];
      const tolerance = 0.01;
      const inside = [...corners, ...sector.placements.map((placement) => ({ x: origin.x + placement.x, z: origin.z + placement.z }))];
      for (const point of inside) {
        const projected = screenAtFloorPoint(camera, viewport, point);
        expect(projected.x).toBeGreaterThanOrEqual(-tolerance);
        expect(projected.x).toBeLessThanOrEqual(viewport.width + tolerance);
        expect(projected.y).toBeGreaterThanOrEqual(-tolerance);
        expect(projected.y).toBeLessThanOrEqual(viewport.height + tolerance);
      }
      // Containment alone is one-sided (any too-zoomed-out fit passes): a fit-bounds corner
      // must land ON a viewport edge.
      const touches = corners.some((point) => {
        const projected = screenAtFloorPoint(camera, viewport, point);
        return (
          Math.abs(projected.x) <= tolerance ||
          Math.abs(projected.x - viewport.width) <= tolerance ||
          Math.abs(projected.y) <= tolerance ||
          Math.abs(projected.y - viewport.height) <= tolerance
        );
      });
      expect(touches).toBe(true);
    },
  );

  it('frames an outdoor sector where it stands in its space', () => {
    const sector = testSector({ origin: { x: 5.12, z: -30.72 }, size: { width: 30.72, depth: 30.72 } });
    const bounds = fitBounds(sector);
    expect(bounds.min).toEqual({ x: 5.12, z: -30.72 });
    expect(bounds.max.x).toBeCloseTo(35.84, 9);
    expect(bounds.max.z).toBe(0);
    const focus = editorFramingFitting(sector, VIEWPORT).focus;
    expect(focus.x).toBeCloseTo(20.48, 9);
    expect(focus.z).toBeCloseTo(-15.36, 9);
  });

  it('is not clamped to the gameplay zoom bounds', () => {
    const sector = testSector({ size: { width: 60, depth: 60 } });
    const framing = editorFramingFitting(sector, VIEWPORT);
    expect(framing.scale).toBeGreaterThan(ORTHO_RIG.maxScale);
  });

  it('widens for a placement standing past the sector edge', () => {
    const bare = testSector();
    const widened = testSector({ placements: [{ id: 'shelf', modelId: 'box', x: 4, z: -1, yaw: 0, elevation: 0 }] });
    expect(fitBounds(widened).min).toEqual({ x: 0, z: -1 });
    expect(editorFramingFitting(widened, VIEWPORT).scale).toBeGreaterThan(editorFramingFitting(bare, VIEWPORT).scale);
  });

  it('falls back to the default scale for a degenerate viewport', () => {
    const framing = editorFramingFittingBounds({ x: 0, z: 0 }, { x: 20, z: 20 }, { width: 0, height: 0 });
    expect(framing.scale).toBe(ORTHO_RIG.defaultScale);
  });
});

describe('playerZoomScale', () => {
  it('tracks viewport height and guards a degenerate one', () => {
    expect(playerZoomScale(480)).toBe(ORTHO_RIG.defaultScale);
    expect(playerZoomScale(960)).toBe(ORTHO_RIG.defaultScale * 2);
    expect(playerZoomScale(0)).toBe(ORTHO_RIG.defaultScale);
  });
});

describe('scrollIntent', () => {
  it('routes command scroll to zoom with raw deltas', () => {
    expect(scrollIntent({ deltaX: 0, deltaY: 3, hasPreciseDeltas: false, commandHeld: true, shiftHeld: false })).toEqual({ kind: 'zoom', deltaY: 3 });
    expect(scrollIntent({ deltaX: 0, deltaY: 3, hasPreciseDeltas: true, commandHeld: true, shiftHeld: false })).toEqual({ kind: 'zoom', deltaY: 3 });
  });

  it('routes plain scroll to a two-axis pan', () => {
    expect(scrollIntent({ deltaX: 4, deltaY: -2, hasPreciseDeltas: true, commandHeld: false, shiftHeld: false })).toEqual({
      kind: 'pan',
      delta: { width: 4, height: -2 },
    });
  });

  it('turns a mouse wheel vertical tick horizontal with shift', () => {
    expect(scrollIntent({ deltaX: 0, deltaY: 2, hasPreciseDeltas: false, commandHeld: false, shiftHeld: true })).toEqual({
      kind: 'pan',
      delta: { width: 20, height: 0 },
    });
    // A trackpad already pans both axes; Shift must not clobber a real horizontal delta.
    expect(scrollIntent({ deltaX: 3, deltaY: 2, hasPreciseDeltas: true, commandHeld: false, shiftHeld: true })).toEqual({
      kind: 'pan',
      delta: { width: 3, height: 2 },
    });
  });
});

describe('EditorCamera', () => {
  function makeCamera(sector: Sector): EditorCamera {
    const camera = new EditorCamera(new THREE.OrthographicCamera());
    camera.refreshFraming(sector);
    return camera;
  }

  it('opens sector-centered at the player zoom', () => {
    const sector = testSector();
    const camera = makeCamera(sector);
    expect(camera.framing.scale).toBe(ORTHO_RIG.defaultScale);
    const fit = editorFramingFitting(sector, camera.viewportSize);
    expect(camera.framing.focus).toEqual(fit.focus);
  });

  it('zooming out stops at the player minimum magnification and keeps the pan', () => {
    const sector = testSector();
    const camera = makeCamera(sector);
    camera.pan({ width: 200, height: 200 }, sector);
    const panned = camera.framing.focus;
    camera.zoom(-500, sector);
    expect(camera.framing.scale).toBeCloseTo(ORTHO_RIG.defaultScale / PLAYER_ZOOM.minFactor, 5);
    expect(camera.framing.focus).toEqual(panned);
  });

  it('zooming back in stops at the player maximum close-up', () => {
    const sector = testSector();
    const camera = makeCamera(sector);
    camera.zoom(-500, sector);
    camera.zoom(2000, sector);
    expect(camera.framing.scale).toBeCloseTo(ORTHO_RIG.defaultScale / PLAYER_ZOOM.maxFactor, 5);
  });

  it('pans the content with the scroll: the ground at the center moves by the delta', () => {
    const sector = testSector();
    const lens = new THREE.OrthographicCamera();
    const camera = new EditorCamera(lens);
    camera.refreshFraming(sector);
    const { x, z } = camera.framing.focus;
    camera.pan({ width: 100, height: -60 }, sector);
    const moved = screenAtFloorPoint(lens, camera.viewportSize, { x, z });
    expect(moved.x).toBeCloseTo(VIEWPORT.width / 2 + 100, 6);
    expect(moved.y).toBeCloseTo(VIEWPORT.height / 2 - 60, 6);
  });

  it('pans the focus to where the shifted center lands and clamps to the fit extent', () => {
    const sector = testSector();
    const camera = makeCamera(sector);
    const opening = structuredClone(camera.framing);
    camera.pan({ width: 0, height: 120 }, sector);
    expect(camera.framing.focus).not.toEqual(opening.focus);
    // A huge pan pins the focus to the fit-extent edge instead of leaving the sector.
    camera.pan({ width: 100_000, height: 100_000 }, sector);
    const bounds = fitBounds(sector);
    const focus = camera.framing.focus;
    expect([focus.x === bounds.min.x || focus.x === bounds.max.x, focus.z === bounds.min.z || focus.z === bounds.max.z]).toEqual([true, true]);
  });

  it('keeps the player magnification through a viewport resize', () => {
    const sector = testSector();
    const camera = makeCamera(sector);
    camera.updateViewportSize({ width: 1280, height: 960 }, sector);
    expect(camera.framing.scale).toBe(playerZoomScale(960));
    const fit = editorFramingFitting(sector, camera.viewportSize);
    expect(camera.framing.focus).toEqual(fit.focus);
  });

  it('preserves the user pan and zoom through a viewport resize', () => {
    const sector = testSector();
    const camera = makeCamera(sector);
    camera.zoom(-50, sector);
    camera.pan({ width: 40, height: 40 }, sector);
    const custom = structuredClone(camera.framing);
    camera.updateViewportSize({ width: 1280, height: 480 }, sector);
    // The zoom factor survives, so the scale re-derives from the same factor over the new
    // height; the focus is untouched (the viewport height did not change here).
    expect(camera.framing.focus).toEqual(custom.focus);
    expect(camera.framing.scale).toBe(custom.scale);
  });

  it('ignores a degenerate or unchanged viewport size', () => {
    const sector = testSector();
    const camera = makeCamera(sector);
    const before = structuredClone(camera.framing);
    camera.updateViewportSize({ width: 0, height: 0 }, sector);
    camera.updateViewportSize(camera.viewportSize, sector);
    expect(camera.framing).toEqual(before);
  });

  it('preserves the user pan and zoom through a reconcile', () => {
    const sector = testSector();
    const camera = makeCamera(sector);
    camera.zoom(-100, sector);
    camera.pan({ width: 40, height: 40 }, sector);
    const custom = structuredClone(camera.framing);
    camera.refreshFraming(sector);
    expect(camera.framing).toEqual(custom);
  });

  it('keeps the opening framing through a reconcile without user navigation', () => {
    const sector = testSector();
    const camera = makeCamera(sector);
    const opening = structuredClone(camera.framing);
    camera.refreshFraming(sector);
    expect(camera.framing).toEqual(opening);
  });

  it('opens a sector smaller than the player view at the player zoom', () => {
    const tiny = testSector({ size: { width: 2, depth: 2 } });
    const camera = makeCamera(tiny);
    const fit = editorFramingFitting(tiny, camera.viewportSize);
    expect(fit.scale).toBeLessThan(ORTHO_RIG.defaultScale);
    expect(camera.framing.scale).toBe(ORTHO_RIG.defaultScale);
    expect(camera.framing.focus).toEqual(fit.focus);
    camera.zoom(2000, tiny);
    expect(camera.framing.scale).toBeCloseTo(ORTHO_RIG.defaultScale / PLAYER_ZOOM.maxFactor, 5);
  });
});
