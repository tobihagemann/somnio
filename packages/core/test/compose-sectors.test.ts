import { describe, expect, it } from 'vitest';
import { composeSectors } from '../scripts/compose/composeSectors.ts';
import { LANDS, ROADS } from '../scripts/compose/rules.ts';
import { buildSpaceCollision, canStand, npcBodies } from '../src/collision.ts';
import { closestOnSegment, distance } from '../src/geometry.ts';
import type { Point } from '../src/geometry.ts';
import { bundledModelRegistry } from '../src/modelRegistry.ts';
import { sectorPointInSpace } from '../src/sector.ts';
import type { Sector } from '../src/sector.ts';
import { writeSectorFile } from '../src/sectorFile.ts';
import { OUTDOOR_SPACE_ID } from '../src/world.ts';
import { loadSectorFixtures } from './support/sectorFixture.ts';

/** The land generator: seeded and stable on its own output, and never touching what was authored by hand. */

const registry = bundledModelRegistry();
const compose = (sectors: readonly Sector[], lands = LANDS): Sector[] => composeSectors(sectors, lands, registry);
const files = (sectors: readonly Sector[]): Record<string, string> => Object.fromEntries(sectors.map((sector) => [sector.name, writeSectorFile(sector)]));

function nearestOnLine(points: readonly Point[], point: Point): number {
  return Math.min(...points.slice(1).map((to, index) => distance(point, closestOnSegment(point, { a: points[index]!, b: to }))));
}

/** Every composed door path stands clear of what blocks once 1.5 m past its arrival point, and ends on the edge of the nearest street. */
function expectDoorPathsWalkable(sectors: readonly Sector[], count: number): void {
  const outdoor = sectors.filter((sector) => sector.kind === 'outdoor');
  const space = { id: OUTDOOR_SPACE_ID, sectors: outdoor };
  const collision = buildSpaceCollision(space, registry);
  const npcs = npcBodies(space);
  const streets = ROADS.filter((road) => road.materialId === 'cobble-town');
  const paths = outdoor.flatMap((sector) =>
    sector.ground.marks.filter((mark) => mark.id.startsWith('gen-path-')).map((mark) => mark.shape.points.map((point) => sectorPointInSpace(sector, point))),
  );
  expect(paths).toHaveLength(count);
  for (const points of paths) {
    // The first point is the doorway, in the building's threshold; the walk starts at the arrival point after it.
    const arrival = points[1]!;
    for (let index = 1; index + 1 < points.length; index += 1) {
      const from = points[index]!;
      const to = points[index + 1]!;
      const steps = Math.ceil(distance(from, to) / 0.05);
      for (let step = 0; step <= steps; step += 1) {
        const sample = { x: from.x + ((to.x - from.x) * step) / steps, z: from.z + ((to.z - from.z) * step) / steps };
        if (distance(sample, arrival) >= 1.5) expect(canStand(collision, sample, npcs), JSON.stringify(sample)).toBe(true);
      }
    }
    const end = points.at(-1)!;
    expect(Math.min(...streets.map((street) => nearestOnLine(street.points, end) - street.radius))).toBeCloseTo(0, 2);
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

  it('keeps a road crossing a border clear for 1.5 m either side, in both lands', () => {
    const road = ROADS.find((candidate) => candidate.id === 'gen-road-north')!;
    for (const sector of compose(loadSectorFixtures()).filter((each) => each.name === 'NorthMeadow' || each.name === 'EdariaSquare')) {
      for (const placement of sector.placements.filter((each) => each.id.startsWith('gen-'))) {
        expect(nearestOnLine(road.points, sectorPointInSpace(sector, placement)), `${sector.name}/${placement.id}`).toBeGreaterThan(road.radius + 1.5);
      }
    }
  });

  it('routes every door path round what blocks, from its doorway to the edge of the nearest street', () => {
    expectDoorPathsWalkable(compose(loadSectorFixtures()), 6);
  });

  it('routes a door path round an NPC standing on its way', () => {
    const sectors = loadSectorFixtures();
    const square = sectors.find((sector) => sector.name === 'EdariaSquare')!;
    square.npcs.push({ id: 'loiterer', name: 'Loiterer', characterModelId: 'fighter-master', x: 15.2, z: 8.8, facing: 0, dialogScript: '' });
    expectDoorPathsWalkable(compose(sectors), 6);
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
