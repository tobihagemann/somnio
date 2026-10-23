import { describe, expect, it } from 'vitest';
import { composeSectors } from '../scripts/compose/composeSectors.ts';
import { CORRIDOR, DOOR_PATH, LANDS, LINKS, OPENINGS, SPLASH_KEEP_OUTS, STREETS } from '../scripts/compose/rules.ts';
import type { KeepOut } from '../scripts/compose/rules.ts';
import { buildSpaceCollision, canStand, npcBodies } from '../src/collision.ts';
import { closestOnSegment, distance, rectContains } from '../src/geometry.ts';
import type { Point } from '../src/geometry.ts';
import { bundledModelRegistry, objectModel } from '../src/modelRegistry.ts';
import { sectorPointInSpace, sectorRect, spawnArea } from '../src/sector.ts';
import type { Sector } from '../src/sector.ts';
import { writeSectorFile } from '../src/sectorFile.ts';
import { OUTDOOR_SPACE_ID } from '../src/world.ts';
import { loadSectorFixtures } from './support/sectorFixture.ts';

/** The land generator: seeded and stable on its own output, and never touching what was authored by hand. */

const registry = bundledModelRegistry();
const compose = (sectors: readonly Sector[], lands = LANDS): Sector[] => composeSectors(sectors, lands, registry);
const files = (sectors: readonly Sector[]): Record<string, string> => Object.fromEntries(sectors.map((sector) => [sector.name, writeSectorFile(sector)]));

function nearestOnLine(points: readonly Point[], point: Point): number {
  if (points.length === 1) return distance(point, points[0]!);
  return Math.min(...points.slice(1).map((to, index) => distance(point, closestOnSegment(point, { a: points[index]!, b: to }))));
}

/** The generated route marks of the outdoor lands, every generated stroke but the worn dabs, in the space's coordinates, each at its painted radius. */
function routes(sectors: readonly Sector[]): (KeepOut & { id: string })[] {
  return sectors
    .filter((sector) => sector.kind === 'outdoor')
    .flatMap((sector) =>
      sector.ground.marks.flatMap((mark) =>
        mark.shape.kind === 'stroke' && mark.id.startsWith('gen-') && !mark.id.startsWith('gen-worn-')
          ? [{ id: mark.id, radius: mark.shape.radius, points: mark.shape.points.map((point) => sectorPointInSpace(sector, point)) }]
          : [],
      ),
    );
}

/** Every route at its radius and the corridor, and every splash keep-out at its own. */
function corridors(sectors: readonly Sector[]): KeepOut[] {
  return [...routes(sectors).map((route) => ({ points: route.points, radius: route.radius + CORRIDOR })), ...SPLASH_KEEP_OUTS];
}

/** How far past the nearest corridor's edge a point stands; negative inside one. */
function margin(keepOuts: readonly KeepOut[], point: Point): number {
  return Math.min(...keepOuts.map((keepOut) => nearestOnLine(keepOut.points, point) - keepOut.radius));
}

/** Every generated placement of the outdoor lands, in the space's coordinates, with the radius of the circle round its footprint. */
function crowns(sectors: readonly Sector[]): { id: string; point: Point; radius: number }[] {
  return sectors
    .filter((sector) => sector.kind === 'outdoor')
    .flatMap((sector) =>
      sector.placements
        .filter((placement) => placement.id.startsWith('gen-'))
        .map((placement) => {
          const footprint = objectModel(registry, placement.modelId)!.footprint;
          return {
            id: `${sector.name}/${placement.id}`,
            point: sectorPointInSpace(sector, placement),
            radius: Math.hypot(footprint.width, footprint.depth) / 2,
          };
        }),
    );
}

/**
 * Every composed path of the kind `prefix` names stands clear of what blocks from its point `first`
 * on, and ends on the edge of the nearest of `goals`. A door path's first point is the doorway, in
 * the building's threshold, so its walk starts at the arrival point after it and skips 1.5 m round it.
 */
function expectPathsWalkable(sectors: readonly Sector[], prefix: string, first: number, count: number, goals: readonly KeepOut[] = STREETS): void {
  const outdoor = sectors.filter((sector) => sector.kind === 'outdoor');
  const space = { id: OUTDOOR_SPACE_ID, sectors: outdoor };
  const collision = buildSpaceCollision(space, registry);
  const npcs = npcBodies(space);
  const paths = outdoor.flatMap((sector) =>
    sector.ground.marks.filter((mark) => mark.id.startsWith(prefix)).map((mark) => mark.shape.points.map((point) => sectorPointInSpace(sector, point))),
  );
  expect(paths).toHaveLength(count);
  for (const points of paths) {
    const start = points[first]!;
    for (let index = first; index + 1 < points.length; index += 1) {
      const from = points[index]!;
      const to = points[index + 1]!;
      const steps = Math.ceil(distance(from, to) / 0.05);
      for (let step = 0; step <= steps; step += 1) {
        const sample = { x: from.x + ((to.x - from.x) * step) / steps, z: from.z + ((to.z - from.z) * step) / steps };
        if (first === 0 || distance(sample, start) >= 1.5) expect(canStand(collision, sample, npcs), JSON.stringify(sample)).toBe(true);
      }
    }
    const end = points.at(-1)!;
    expect(Math.min(...goals.map((goal) => nearestOnLine(goal.points, end) - goal.radius))).toBeCloseTo(0, 2);
  }
}

describe('composing the lands', () => {
  it('writes the same bytes composing the committed world, and composing that again', () => {
    const once = compose(loadSectorFixtures());
    expect(files(compose(once))).toEqual(files(once));
    expect(files(once)).toEqual(files(loadSectorFixtures()));
  });

  it('dresses a land differently from another seed', () => {
    const generated = (sectors: Sector[]): string[] =>
      sectors
        .find((sector) => sector.name === 'NorthWood')!
        .placements.filter((placement) => placement.id.startsWith('gen-'))
        .map((placement) => JSON.stringify(placement));
    const reseeded = LANDS.map((land) => (land.sector === 'NorthWood' ? { ...land, seed: land.seed + 1 } : land));
    expect(generated(compose(loadSectorFixtures(), reseeded))).not.toEqual(generated(compose(loadSectorFixtures())));
  });

  it('keeps every crown off every corridor, clearing, and monster spawn area', () => {
    const composed = compose(loadSectorFixtures());
    const keepOuts = corridors(composed);
    const clearings = LANDS.flatMap((land) => land.clearings);
    const spawnAreas = composed
      .filter((sector) => sector.kind === 'outdoor')
      .flatMap((sector) => sector.monsterSpawns.map((spawn) => spawnArea(sector, spawn)));
    for (const crown of crowns(composed)) {
      // Placements are written to the millimetre, a little off where they were judged.
      const radius = crown.radius - 0.001;
      expect(margin(keepOuts, crown.point) - radius, crown.id).toBeGreaterThan(0);
      expect(Math.min(...clearings.map((clearing) => distance(crown.point, clearing) - clearing.radius)) - radius, crown.id).toBeGreaterThan(0);
      expect(
        spawnAreas.some((area) => rectContains(area, crown.point, radius)),
        crown.id,
      ).toBe(false);
    }
  });

  it('thins the dressing beside every corridor', () => {
    const composed = compose(loadSectorFixtures());
    const keepOuts = corridors(composed);
    const near = { placements: 0, cells: 0 };
    const far = { placements: 0, cells: 0 };
    const band = (value: number): typeof near | undefined => (value >= 0 && value < 1.5 ? near : value >= 3 && value < 6 ? far : undefined);
    for (const crown of crowns(composed)) {
      const counted = band(margin(keepOuts, crown.point) - crown.radius);
      if (counted !== undefined) counted.placements += 1;
    }
    for (const rect of composed.filter((sector) => sector.kind === 'outdoor').map(sectorRect)) {
      for (let x = rect.x + 0.25; x < rect.x + rect.width; x += 0.5) {
        for (let z = rect.z + 0.25; z < rect.z + rect.depth; z += 0.5) {
          // A typical crown's radius, so a cell's margin reads as a placement's would there.
          const counted = band(margin(keepOuts, { x, z }) - 0.7);
          if (counted !== undefined) counted.cells += 1;
        }
      }
    }
    expect(near.placements / near.cells / (far.placements / far.cells)).toBeLessThanOrEqual(0.7);
  });

  it('routes and clears every wall gap of the town', () => {
    const gaps = [
      { x: 20.48, z: 0 },
      { x: 0, z: 20.48 },
      { x: 40.96, z: 20.48 },
      { x: 20.48, z: 40.96 },
      { x: 9.28, z: 15.68 },
      { x: 15.68, z: 9.28 },
      { x: 31.68, z: 15.68 },
      { x: 25.28, z: 9.28 },
      { x: 9.28, z: 25.28 },
      { x: 15.68, z: 31.68 },
      { x: 31.68, z: 25.28 },
      { x: 25.28, z: 31.68 },
    ];
    const painted = routes(compose(loadSectorFixtures()));
    const unrouted = gaps.filter((gap) => !painted.some((route) => nearestOnLine(route.points, gap) <= route.radius));
    expect(unrouted).toEqual([]);
  });

  it('routes every door path round what blocks, from its doorway to the edge of the nearest street', () => {
    expectPathsWalkable(compose(loadSectorFixtures()), 'gen-path-', 1, 6);
  });

  it('routes a door path round an NPC standing on its way', () => {
    const sectors = loadSectorFixtures();
    const square = sectors.find((sector) => sector.name === 'EdariaSquare')!;
    square.npcs.push({ id: 'loiterer', name: 'Loiterer', characterModelId: 'fighter-master', x: 15.2, z: 8.8, facing: 0, dialogScript: '' });
    expectPathsWalkable(compose(sectors), 'gen-path-', 1, 6);
  });

  it('routes each unused compound opening from the street into its yard', () => {
    const composed = compose(loadSectorFixtures());
    expectPathsWalkable(composed, 'gen-opening-', 0, OPENINGS.length);
    const painted = routes(composed);
    const byId = (id: string): KeepOut | undefined => painted.find((route) => route.id === id);
    for (const opening of OPENINGS) expect(byId(opening.id), opening.id).toBeDefined();
    const start = byId('gen-opening-nw-south')!.points[0]!;
    const doorPaths = ['gen-path-to-edariainn', 'gen-path-to-edariahealerhall'].map((id) => byId(id)!);
    expect(Math.min(...doorPaths.map((path) => nearestOnLine(path.points, start)))).toBeLessThanOrEqual(DOOR_PATH.radius + 0.01);
  });

  it("joins a compound's two doors whose paths do not meet, from one's arrival point to the edge of the other's path", () => {
    const composed = compose(loadSectorFixtures());
    const painted = routes(composed);
    const byId = (id: string): KeepOut => painted.find((route) => route.id === id)!;
    expectPathsWalkable(
      composed,
      'gen-link-',
      0,
      LINKS.length,
      painted.filter((route) => route.id.startsWith('gen-path-')),
    );
    for (const link of LINKS) {
      const points = byId(link.id).points;
      expect(points[0], link.id).toEqual(byId(`gen-path-${link.from}`).points[1]);
      expect(nearestOnLine(byId(`gen-path-${link.to}`).points, points.at(-1)!), link.id).toBeCloseTo(DOOR_PATH.radius, 2);
    }
  });

  it('keeps a hand-authored placement and mark through two runs, the mark painted after every generated one', () => {
    const sectors = loadSectorFixtures();
    const meadow = sectors.find((sector) => sector.name === 'NorthMeadow')!;
    const well = { id: 'old-well', modelId: 'well', x: 4, z: 4, yaw: 0, elevation: 0 };
    const touchUp = { id: 'touch-up', materialId: 'grass-meadow', opacity: 1, shape: { kind: 'stroke' as const, radius: 1, points: [{ x: 15.4, z: 20 }] } };
    meadow.placements.push(well);
    meadow.ground.marks.push(touchUp);

    const twice = compose(compose(sectors)).find((sector) => sector.name === 'NorthMeadow')!;

    expect(twice.placements).toContainEqual(well);
    expect(twice.ground.marks.at(-1)).toEqual(touchUp);
    expect(twice.ground.marks.slice(0, -1).every((mark) => mark.id.startsWith('gen-'))).toBe(true);
  });
});
