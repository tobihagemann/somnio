import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EDGE_TOLERANCE,
  MOVE_SUBSTEP,
  OUTDOOR_SPACE_ID,
  SOMNIO_CONSTANTS,
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
import { ORTHO_RIG, clampedScale, worldMovement } from '@/scene/cameraRig';
import { NAME_PLAQUE, OVERLAY_METRES_PER_PIXEL, PLAQUE_FEET_GAP, renderNamePlaque } from '@/scene/overlayArt';
import { splashSectors } from '@/splash/sectors';
import { DIP_SECONDS, PRE_LOGIN_CARD, SPLASH_REEL, WORDMARK_BAND_INSET, pathPoint, pathSeconds, shotFraming, stageReel } from '@/splash/reel';
import type { StagedActor, StagedShot, Viewport } from '@/splash/reel';
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

/** Each dreamer a shot's NPC greets, from the moment the greeting is said. */
function greeted(shot: StagedShot): { listener: StagedActor; npc: StagedActor; at: number }[] {
  return SPLASH_REEL.find((each) => each.id === shot.id)!.beats.flatMap((beat) =>
    beat.kind === 'greeting'
      ? [
          {
            listener: shot.actors.find((actor) => actor.kind === 'peer' && actor.name === beat.listener)!,
            npc: shot.actors.find((actor) => actor.id === beat.npc)!,
            at: beat.at,
          },
        ]
      : [],
  );
}

/** How tall a figure is taken to stand, for its head to clear what covers the screen too. */
const FIGURE_HEIGHT = 1.6;

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Where a figure is drawn, in CSS pixels: as wide as its body or the name plate under its feet,
 * whichever is wider, from its head down to the plate's foot. The plate hangs in the screen's plane,
 * sized in metres like every overlay.
 */
function drawnBox(actor: StagedActor, seconds: number, focus: Point, scale: number, viewport: Viewport): Box {
  const plate = renderNamePlaque(actor.name, actor.kind === 'npc' ? NAME_PLAQUE.npcBackground : NAME_PLAQUE.playerBackground, false);
  const pixelsPerMetre = viewport.height / 2 / scale;
  const halfWidth = Math.max(actor.radius, (plate.widthPixels * OVERLAY_METRES_PER_PIXEL) / 2) * pixelsPerMetre;
  const feet = drawnAt(pathPoint(actor, seconds), 0, focus, scale, viewport);
  const head = drawnAt(pathPoint(actor, seconds), FIGURE_HEIGHT, focus, scale, viewport);
  return {
    left: feet.x - halfWidth,
    right: feet.x + halfWidth,
    top: head.y,
    bottom: feet.y + (plate.heightPixels * OVERLAY_METRES_PER_PIXEL + PLAQUE_FEET_GAP) * pixelsPerMetre,
  };
}

function onScreen(box: Box, viewport: Viewport): boolean {
  return box.left >= 0 && box.right <= viewport.width && box.top >= 0 && box.bottom <= viewport.height;
}

/**
 * Whether a box reaches into the card's column, from the top of the wordmark band down to the card's
 * foot, where no framed figure may be drawn. The wordmark is narrower than the card.
 */
function covered(box: Box, viewport: Viewport): boolean {
  const middle = { x: viewport.width / 2, y: viewport.height / 2 };
  return (
    box.right > middle.x - PRE_LOGIN_CARD.width / 2 &&
    box.left < middle.x + PRE_LOGIN_CARD.width / 2 &&
    box.bottom > WORDMARK_BAND_INSET &&
    box.top < middle.y + PRE_LOGIN_CARD.height / 2
  );
}

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

  it.each(reel.map((shot) => [shot.id, shot] as const))(
    'draws every figure %s is about, and every figure standing in a followed shot, whole on screen, its plate included, clear of the card and the wordmark',
    (_id, shot) => {
      const named = namedFigures(shot);
      for (const viewport of VIEWPORTS) {
        for (const seconds of moments(shot)) {
          const { focus, scale } = shotFraming(shot, seconds, viewport);
          // A shot that follows a subject also frames every figure once it stands, the dreamer an NPC greets among them.
          const standing = shot.camera.kind === 'subject' ? shot.actors.filter((actor) => seconds >= pathSeconds(actor)).map((actor) => actor.id) : [];
          const figures = [...new Set([...named, ...standing])];
          for (const id of figures) {
            const box = drawnBox(
              shot.actors.find((candidate) => candidate.id === id)!,
              seconds,
              focus,
              scale,
              viewport,
            );
            const where = `${id} in ${viewport.width}x${viewport.height} at ${seconds}s`;
            expect(onScreen(box, viewport), `${where} is on screen`).toBe(true);
            expect(covered(box, viewport), where).toBe(false);
          }
        }
      }
    },
  );

  /** A window too narrow to hold a shot beside the card still frames it, at a scale the scene draws at, so the subject lands where the framing puts it. */
  it.each(reel.map((shot) => [shot.id, shot] as const))('frames %s finitely on a window narrower than every tested viewport', (_id, shot) => {
    for (const width of [400, 559, 560, 561, 600, 700, 899]) {
      for (const height of [640, 900]) {
        for (const seconds of moments(shot)) {
          const { focus, scale } = shotFraming(shot, seconds, { width, height });
          const where = `${width}x${height} at ${seconds}s`;
          expect([focus.x, focus.z, scale].every(Number.isFinite), where).toBe(true);
          expect(scale, where).toBe(clampedScale(scale));
          if (shot.camera.kind === 'subject' && width <= PRE_LOGIN_CARD.width) expect(scale, `${where} pulls back as far as it goes`).toBe(ORTHO_RIG.maxScale);
          if (shot.camera.kind === 'subject') {
            const camera = shot.camera;
            const subject =
              typeof camera.subject === 'string'
                ? pathPoint(
                    shot.actors.find((actor) => actor.id === camera.subject)!,
                    seconds,
                  )
                : camera.subject;
            const at = drawnAt(subject, 0, focus, scale, { width, height });
            const across = (PRE_LOGIN_CARD.width / 2 + width / 2) / 2;
            expect(at.x, `${where} draws the subject beside the card`).toBeCloseTo(width / 2 + (camera.side === 'right' ? across : -across), 3);
            expect(at.y, `${where} draws the subject at its drop`).toBeCloseTo(height / 2 + (camera.drop * height) / 2, 3);
          }
        }
      }
    }
  });

  it('moves no scripted dreamer at the walk gait', () => {
    for (const shot of reel) {
      for (const actor of shot.actors.filter((candidate) => candidate.kind === 'peer')) expect(actor.gait, `${shot.id}: ${actor.id}`).not.toBe('walk');
    }
  });

  it('greets each dreamer once they stop within speaking distance', () => {
    for (const shot of reel) {
      for (const { listener, npc, at } of greeted(shot)) {
        expect(pathSeconds(listener), `${shot.id}: ${listener.id} stops first`).toBeLessThanOrEqual(at);
        expect(at, `${shot.id}: the greeting comes before the dip`).toBeLessThan(shot.seconds - DIP_SECONDS);
        expect(distance(pathPoint(listener, at), npc.start), `${shot.id}: ${listener.id} stands near ${npc.id}`).toBeLessThanOrEqual(
          SOMNIO_CONSTANTS.npcInteractionRadius,
        );
      }
    }
    for (const id of ['inn', 'library']) expect(greeted(reel.find((shot) => shot.id === id)!), id).toHaveLength(1);
  });

  it.each(reel.filter((shot) => shot.camera.kind === 'area').map((shot) => [shot.id, shot] as const))(
    'keeps every mover of %s on screen while it moves',
    (_id, shot) => {
      const movers = shot.actors.filter((actor) => actor.kind !== 'npc' && actor.path.length > 0);
      for (const viewport of VIEWPORTS) {
        for (const seconds of moments(shot)) {
          const { focus, scale } = shotFraming(shot, seconds, viewport);
          for (const actor of movers.filter((mover) => seconds < pathSeconds(mover))) {
            const where = `${actor.id} in ${viewport.width}x${viewport.height} at ${seconds}s`;
            expect(onScreen(drawnBox(actor, seconds, focus, scale, viewport), viewport), `${where} is on screen`).toBe(true);
          }
        }
      }
    },
  );

  it("keeps the town's dreamers moving for most of the shot, Odo at a run", () => {
    const town = reel.find((shot) => shot.id === 'town')!;
    const dreamers = town.actors.filter((actor) => actor.kind === 'peer');
    for (const actor of dreamers) expect(pathSeconds(actor), actor.id).toBeGreaterThan(town.seconds / 2);
    expect(dreamers.find((actor) => actor.name === 'Odo')?.gait).toBe('run');
  });
});
