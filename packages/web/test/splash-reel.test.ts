import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EDGE_TOLERANCE,
  MOVE_SUBSTEP,
  OUTDOOR_SPACE_ID,
  buildSpaceCollision,
  buildWorld,
  bundledModelRegistry,
  canStand,
  distance,
  groundHeightAt,
  isLegalMove,
  npcBodies,
  rectContains,
  sectorRect,
  spawnArea,
} from '@somnio/core';
import type { Point, Rect } from '@somnio/core';
import { ORTHO_RIG, worldMovement } from '@/scene/cameraRig';
import { splashSectors } from '@/splash/sectors';
import { DIP_SECONDS, PRE_LOGIN_CARD, SPLASH_REEL, WORDMARK_BAND_INSET, pathPoint, pathSeconds, shotFraming, stageReel } from '@/splash/reel';
import type { StagedShot, Viewport } from '@/splash/reel';
import { SECTOR_FIXTURES_DIRECTORY } from '../../core/test/support/sectorFixture.ts';

/**
 * The reel against the committed world it is staged from. Edit a sector fixture and a scripted
 * path may run into a new wall, or a framing may show the void past a moved edge: this is where
 * either fails, rather than on a deployed page.
 */

const registry = bundledModelRegistry();
const sectors = splashSectors();
const world = buildWorld(sectors, registry);
const reel = stageReel(SPLASH_REEL, sectors, registry);

const pitch = (ORTHO_RIG.pitchDegrees * Math.PI) / 180;
const right = worldMovement(1, 0);
const down = worldMovement(0, 1);

/** Windows from 900 wide to a 4K screen's 3840, at least 640 high, between 4:3 and 21:9: the framing holds in every one. */
const VIEWPORTS: Viewport[] = [900, 1024, 1440, 1920, 2560, 3200, 3840].flatMap((width) =>
  [640, 768, 900, 1080, 1200, 1440, 1600, 2160, Math.ceil((width * 9) / 21), Math.floor((width * 3) / 4)]
    .filter((height, index, all) => all.indexOf(height) === index)
    .filter((height) => height >= 640 && width / height >= 4 / 3 - 1e-9 && width / height <= 21 / 9 + 1e-9)
    .map((height) => ({ width, height })),
);

/** The moments a shot's framing passes through: its start, its end, and every quarter second between. */
function moments(shot: StagedShot): number[] {
  const steps = Math.round(shot.seconds / 0.25);
  return Array.from({ length: steps + 1 }, (_, index) => (index * shot.seconds) / steps);
}

/** Where a point is drawn, in CSS pixels from the viewport's top left. */
function drawnAt(point: Point, height: number, focus: Point, scale: number, viewport: Viewport): { x: number; y: number } {
  const offset = { x: point.x - focus.x, z: point.z - focus.z };
  const across = offset.x * right.dx + offset.z * right.dz;
  const below = (offset.x * down.dx + offset.z * down.dz) * Math.sin(pitch) - height * Math.cos(pitch);
  const pixelsPerMetre = viewport.height / 2 / scale;
  return { x: viewport.width / 2 + across * pixelsPerMetre, y: viewport.height / 2 + below * pixelsPerMetre };
}

/** The ground the camera shows: the view's corners carried down onto the floor. */
function footprint(focus: Point, scale: number, viewport: Viewport): Point[] {
  const across = scale * (viewport.width / viewport.height);
  const along = scale / Math.sin(pitch);
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([sideways, lengthways]) => ({
    x: focus.x + sideways! * across * right.dx + lengthways! * along * down.dx,
    z: focus.z + sideways! * across * right.dz + lengthways! * along * down.dz,
  }));
}

const outdoorRects = sectors.filter((sector) => sector.kind === 'outdoor').map(sectorRect);
const insideOutdoors = (point: Point): boolean => outdoorRects.some((rect) => rectContains(rect, point, EDGE_TOLERANCE));

/** The union's concave corners: where three of the four quarters round a sector corner are ground. */
const reflexCorners: Point[] = outdoorRects
  .flatMap((rect: Rect) => [
    { x: rect.x, z: rect.z },
    { x: rect.x + rect.width, z: rect.z },
    { x: rect.x, z: rect.z + rect.depth },
    { x: rect.x + rect.width, z: rect.z + rect.depth },
  ])
  .filter((corner) => {
    const step = 0.01;
    const quarters = [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ].filter(([dx, dz]) => outdoorRects.some((rect) => rectContains(rect, { x: corner.x + dx! * step, z: corner.z + dz! * step })));
    return quarters.length === 3;
  });

function strictlyInside(polygon: readonly Point[], point: Point): boolean {
  return polygon.every((from, index) => {
    const to = polygon[(index + 1) % polygon.length]!;
    return (to.x - from.x) * (point.z - from.z) - (to.z - from.z) * (point.x - from.x) > 1e-9;
  });
}

/** Points every 0.25 m along the polygon's edges, its corners included. */
function edgeSamples(polygon: readonly Point[]): Point[] {
  return polygon.flatMap((from, index) => {
    const to = polygon[(index + 1) % polygon.length]!;
    const count = Math.max(1, Math.ceil(distance(from, to) / 0.25));
    return Array.from({ length: count }, (_, step) => ({ x: from.x + ((to.x - from.x) * step) / count, z: from.z + ((to.z - from.z) * step) / count }));
  });
}

/** The figures a shot is about: its subject and every actor its beats name. */
function namedFigures(shot: StagedShot): string[] {
  const named = new Set<string>();
  if (shot.camera.kind === 'subject' && typeof shot.camera.subject === 'string') named.add(shot.camera.subject);
  for (const beat of shot.beats) {
    switch (beat.kind) {
      case 'blow':
        named.add(beat.attacker).add(beat.target);
        break;
      case 'condition':
        named.add(beat.id);
        break;
      case 'raise':
        named.add(beat.target);
        break;
      case 'speech':
        named.add(beat.speaker);
        break;
    }
  }
  return [...named];
}

/** Whether a point lies under the login card or the wordmark band, where no figure a shot is about may be drawn. */
function covered(point: { x: number; y: number }, viewport: Viewport): boolean {
  const middle = { x: viewport.width / 2, y: viewport.height / 2 };
  const underCard = Math.abs(point.x - middle.x) < PRE_LOGIN_CARD.width / 2 && Math.abs(point.y - middle.y) < PRE_LOGIN_CARD.height / 2;
  const bandBottom = middle.y - PRE_LOGIN_CARD.height / 2 - WORDMARK_BAND_INSET;
  return underCard || (point.y > WORDMARK_BAND_INSET && point.y < bandBottom);
}

/** How tall a figure is taken to stand, for its head to clear what covers the screen too. */
const FIGURE_HEIGHT = 1.6;

describe('the splash reel', () => {
  it('plays its shots in the fixed order', () => {
    expect(reel.map((shot) => shot.id)).toEqual([
      'town',
      'follow-dreamer',
      'npc-greeting',
      'speech',
      'follow-nightmare',
      'combat',
      'raise',
      'inn',
      'library',
      'time-lapse',
    ]);
  });

  it.each(reel.map((shot) => [shot.id, shot] as const))('holds %s for 6 to 8 seconds, in daylight unless it is the time-lapse', (id, shot) => {
    expect(shot.seconds).toBeGreaterThanOrEqual(6);
    expect(shot.seconds).toBeLessThanOrEqual(8);
    if (id === 'time-lapse') {
      expect(shot.hour).toEqual({ from: 16, to: 31 });
    } else {
      expect(shot.hour).toBeGreaterThanOrEqual(9);
      expect(shot.hour).toBeLessThanOrEqual(15);
    }
  });

  /** A sector the server ships but the splash leaves out would show as void where the live world has ground. */
  it('stages every committed sector', () => {
    const committed = readdirSync(SECTOR_FIXTURES_DIRECTORY).filter((file) => file.endsWith('.somnio-sector'));
    expect(sectors.map((sector) => `${sector.name}.somnio-sector`).sort()).toEqual(committed.sort());
  });

  it('stages each shot in a space the world builds, opening with nothing carried', () => {
    expect(reel[0]!.actors.some((actor) => actor.carried)).toBe(false);
    for (const shot of reel) expect(world.spaces.has(shot.space), shot.id).toBe(true);
  });

  it.each(reel.map((shot) => [shot.id, shot] as const))('walks every figure of %s along legal ground at height 0', (_id, shot) => {
    const space = world.spaces.get(shot.space)!;
    const collision = buildSpaceCollision(space, registry);
    const npcs = npcBodies(space);
    for (const actor of shot.actors) {
      if (actor.kind === 'npc') continue;
      if (!actor.carried) expect(canStand(collision, actor.start, npcs), `${actor.id} stands at its start`).toBe(true);
      let from = actor.start;
      for (const to of actor.path) {
        expect(isLegalMove(collision, from, to, actor.radius, npcs), `${actor.id} walks to (${to.x}, ${to.z})`).toBe(true);
        const count = Math.max(1, Math.ceil(distance(from, to) / MOVE_SUBSTEP));
        for (let step = 0; step <= count; step += 1) {
          const sample = { x: from.x + ((to.x - from.x) * step) / count, z: from.z + ((to.z - from.z) * step) / count };
          expect(groundHeightAt(collision, sample), `${actor.id} keeps to the ground`).toBe(0);
        }
        from = to;
      }
    }
  });

  it('starts every nightmare inside its spawn area', () => {
    const northWood = sectors.find((sector) => sector.name === 'NorthWood')!;
    const area = spawnArea(northWood, northWood.monsterSpawns[0]!);
    for (const shot of reel) {
      for (const actor of shot.actors) {
        if (actor.kind === 'monster' && !actor.carried) expect(rectContains(area, actor.start), actor.id).toBe(true);
      }
    }
  });

  /** Where a carried figure stands at the cut must not depend on how the frames fell, and one lying fallen stays down. */
  it('carries a figure over only once it has stopped, from where it stopped', () => {
    reel.forEach((shot, index) => {
      const before = reel[index - 1];
      const stillThere = before?.space === shot.space ? before.actors.map((actor) => actor.id) : [];
      for (const actor of shot.actors.filter((candidate) => !candidate.carried))
        expect(stillThere, `${shot.id} places ${actor.id} anew`).not.toContain(actor.id);
      for (const actor of shot.actors.filter((candidate) => candidate.carried)) {
        const previous = before?.actors.find((candidate) => candidate.id === actor.id);
        expect(previous, `${shot.id} carries ${actor.id}`).toBeDefined();
        expect(before!.space).toBe(shot.space);
        expect(actor.start).toEqual(pathPoint(previous!, Number.POSITIVE_INFINITY));
        expect(pathSeconds(previous!), `${actor.id} stops before the dip`).toBeLessThanOrEqual(before!.seconds - DIP_SECONDS);
        if (actor.condition === 'fallen') expect(actor.path).toEqual([]);
      }
    });
  });

  it.each(reel.filter((shot) => shot.space === OUTDOOR_SPACE_ID).map((shot) => [shot.id, shot] as const))(
    'never shows the void past the outer sectors in %s',
    (_id, shot) => {
      for (const viewport of VIEWPORTS) {
        for (const seconds of moments(shot)) {
          const { focus, scale } = shotFraming(shot, seconds, viewport);
          const ground = footprint(focus, scale, viewport);
          const where = `${viewport.width}x${viewport.height} at ${seconds}s`;
          expect(edgeSamples(ground).every(insideOutdoors), where).toBe(true);
          expect(
            reflexCorners.some((corner) => strictlyInside(ground, corner)),
            where,
          ).toBe(false);
        }
      }
    },
  );

  it.each(reel.map((shot) => [shot.id, shot] as const))('draws every figure %s is about on screen, beside the card and below the wordmark', (_id, shot) => {
    const figures = namedFigures(shot);
    for (const viewport of VIEWPORTS) {
      for (const seconds of moments(shot)) {
        const { focus, scale } = shotFraming(shot, seconds, viewport);
        for (const id of figures) {
          const actor = shot.actors.find((candidate) => candidate.id === id)!;
          const feet = pathPoint(actor, seconds);
          for (const height of [0, FIGURE_HEIGHT]) {
            const drawn = drawnAt(feet, height, focus, scale, viewport);
            const where = `${id} at ${height} m in ${viewport.width}x${viewport.height} at ${seconds}s`;
            expect(drawn.x >= 0 && drawn.x <= viewport.width && drawn.y >= 0 && drawn.y <= viewport.height, `${where} is on screen`).toBe(true);
            expect(covered(drawn, viewport), where).toBe(false);
          }
        }
      }
    }
  });
});
