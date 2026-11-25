import { describe, expect, it } from 'vitest';
import { MOVE_SUBSTEP, buildSpaceCollision } from '../src/collision.ts';
import { SOMNIO_CONSTANTS } from '../src/constants.ts';
import { EDGE_TOLERANCE, distanceToRect } from '../src/geometry.ts';
import type { Point, Rect } from '../src/geometry.ts';
import { hashString, seededSequence } from '../src/hash.ts';
import { buildModelGrid, someModelNear } from '../src/modelGrid.ts';
import type { ModelGrid } from '../src/modelGrid.ts';
import { bundledModelRegistry } from '../src/modelRegistry.ts';
import { sectorRect } from '../src/sector.ts';
import { buildWorld } from '../src/world.ts';
import { loadSectorFixtures } from './support/sectorFixture.ts';

interface Model {
  transform: Point;
  reach: number;
}

/** The indexes of the models the grid visits that pass the reach test, a model visited twice listed twice. */
function visited(grid: ModelGrid<Model>, models: readonly Model[], rect: Rect, reach: number): number[] {
  const indexes: number[] = [];
  someModelNear(grid, rect, reach, (model) => {
    if (distanceToRect(model.transform, rect) <= model.reach + reach) indexes.push(models.indexOf(model));
    return false;
  });
  return indexes.sort((a, b) => a - b);
}

/** The indexes of every model that passes the reach test, by a scan of them all. */
function scanned(models: readonly Model[], rect: Rect, reach: number): number[] {
  return models.flatMap((model, index) => (distanceToRect(model.transform, rect) <= model.reach + reach ? [index] : []));
}

function at(point: Point): Rect {
  return { ...point, width: 0, depth: 0 };
}

describe('the model grid', () => {
  it('visits each model a scan of them all keeps, once, wherever the query lies', () => {
    const random = seededSequence(hashString('the model grid'));
    const coordinate = (): number => (random() - 0.5) * 60;
    for (const count of [0, 1, 50, 120, 300]) {
      const models = Array.from({ length: count }, () => ({ transform: { x: coordinate(), z: coordinate() }, reach: random() * 6 }));
      const grid = buildModelGrid(models);
      for (let query = 0; query < 400; query += 1) {
        // Each coordinate lies on a cell's edge a third of the time, so over half the queries lie on one in one axis or both.
        const onLine = (value: number): number => (random() < 1 / 3 ? Math.round(value / 2) * 2 : value);
        const point = { x: onLine(coordinate() * 1.2), z: onLine(coordinate() * 1.2) };
        const rect = random() < 0.5 ? at(point) : { ...point, width: random() * 8, depth: random() * 8 };
        const reach = random() * 6;
        expect(visited(grid, models, rect, reach), `${count} models, query ${query}`).toEqual(scanned(models, rect, reach));
      }
    }
  });

  /**
   * West and north, the model's reach square ends at 1.9999999999999998, in the cell before the one
   * the query's circle starts in, yet 4 + 0.9999999999999998 rounds to 5. East and south, the
   * query's circle ends at 5.999999999999999, in the cell before the one the model's reach square
   * starts in, yet 7.1 - 4.699999999999999 is no more than 1.1 + 1.3. The reach test keeps each.
   */
  it.each<[string, Model, Point, number]>([
    ['west', { transform: { x: 1, z: 10 }, reach: 0.9999999999999998 }, { x: 6, z: 10 }, 4],
    ['north', { transform: { x: 10, z: 1 }, reach: 0.9999999999999998 }, { x: 10, z: 6 }, 4],
    ['east', { transform: { x: 7.1, z: 10 }, reach: 1.1 }, { x: 4.699999999999999, z: 10 }, 1.3],
    ['south', { transform: { x: 10, z: 7.1 }, reach: 1.1 }, { x: 10, z: 4.699999999999999 }, 1.3],
  ])("visits a model %s of the query whose reach misses the query's cells by a rounding error", (_side, model, point, reach) => {
    expect(visited(buildModelGrid([model]), [model], at(point), reach)).toEqual([0]);
  });

  it('files only the cells its models reach, however far apart they stand', () => {
    const models = [
      { transform: { x: -10_000, z: -10_000 }, reach: 1 },
      { transform: { x: 10_000, z: 10_000 }, reach: 1 },
    ];
    const grid = buildModelGrid(models);
    expect(visited(grid, models, at(models[0]!.transform), 0)).toEqual([0]);
    expect(visited(grid, models, at(models[1]!.transform), 0)).toEqual([1]);
    expect(grid.cells.size).toBe(8);
  });

  it('stops at the first model the visit accepts', () => {
    const models = [0, 1, 2].map((index) => ({ transform: { x: 1 + index / 10, z: 1 }, reach: 0.5 }));
    let visits = 0;
    const found = someModelNear(buildModelGrid(models), at({ x: 1, z: 1 }), 1, () => {
      visits += 1;
      return true;
    });
    expect(found).toBe(true);
    expect(visits).toBe(1);
  });

  it('visits each model a scan keeps over the committed outdoor world, at the radii the checks use', () => {
    const registry = bundledModelRegistry();
    const space = buildWorld(loadSectorFixtures(), registry).spaces.get('outdoors')!;
    const { models, modelGrid } = buildSpaceCollision(space, registry);
    const radii = [0, EDGE_TOLERANCE, SOMNIO_CONSTANTS.playerRadius - SOMNIO_CONSTANTS.pathTolerance, SOMNIO_CONSTANTS.playerRadius + MOVE_SUBSTEP];
    const random = seededSequence(hashString('the model grid over the world'));
    for (const sector of space.sectors) {
      const rect = sectorRect(sector);
      for (let sample = 0; sample < 100; sample += 1) {
        const point = { x: rect.x + random() * rect.width, z: rect.z + random() * rect.depth };
        for (const radius of radii)
          expect(visited(modelGrid, models, at(point), radius), `${sector.name} (${point.x}, ${point.z}) at ${radius}`).toEqual(
            scanned(models, at(point), radius),
          );
      }
    }
  });
});
