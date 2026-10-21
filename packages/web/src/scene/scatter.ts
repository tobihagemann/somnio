import {
  SOMNIO_CONSTANTS,
  clamp,
  distance,
  fbm,
  hash2,
  hashString,
  objectModel,
  rectContains,
  resolveDoor,
  sectorOrigin,
  sectorRect,
  worldToModel,
} from '@somnio/core';
import type { ModelRegistry, Point, Rect, Transform } from '@somnio/core';
import type { SectorView } from '@somnio/protocol';
import { sampleGroundField } from './groundField';
import type { GroundField } from './groundField';
import { GROUND_MATERIAL_IDS } from './groundMaterials';
import type { GroundMaterialId } from './groundMaterials';

/**
 * What grows on a sector's ground and never blocks: grass tufts, flower clusters, and pebbles,
 * placed by seed from the sector's name, so every consumer that draws the sector with the same
 * neighbours draws the same scatter. It follows the painted ground's weights, and keeps off what
 * blocks and off the doors, the sector's own and its touching neighbours', since nothing confines
 * a placement's footprint to its sector.
 */

/** The models scatter places, by registry id: they are measured and have no colliders. */
export const GRASS_MODEL_IDS = ['grass-1-a', 'grass-1-b', 'grass-2-a', 'grass-2-b'] as const;
export const PEBBLE_MODEL_ID = 'pebble';

/** The side of a cell of the jittered grid scatter walks, in metres; tuned in the game. */
const CELL_METRES = 0.42;
/** A single knob over how much grows. */
const SCATTER_DENSITY = 1;
const FLOWER_COLOURS = [0xfff5ee, 0xffd34d, 0xff8fb1, 0x9db8ff] as const;

export interface ScatterTuft {
  modelId: string;
  x: number;
  z: number;
  yaw: number;
}

interface ScatterFlower {
  x: number;
  z: number;
  colour: number;
  height: number;
}

export interface Scatter {
  tufts: ScatterTuft[];
  pebbles: ScatterTuft[];
  flowers: ScatterFlower[];
}

export interface ScatterInputs {
  sector: SectorView;
  /** The sectors touching it, whose placements and doors it keeps off too. */
  neighbours: readonly SectorView[];
  field: GroundField;
  registry: ModelRegistry;
}

interface Obstacle {
  transform: Transform;
  rect: Rect;
}

/** How far scatter keeps from a door's arrival point, so an arriving body is not drawn standing in a tuft. */
const ARRIVAL_CLEARANCE = 0.5;
/** The side of the buckets the obstacles and doors are filed in, so a point is tested only against those near it. */
const BUCKET_METRES = 2;

export function scatterSector(inputs: ScatterInputs): Scatter {
  const { sector, field } = inputs;
  const rect = sectorRect(sector);
  const seed = hashString(sector.name);
  const channel = (id: GroundMaterialId): number => GROUND_MATERIAL_IDS.indexOf(id);
  const grass = channel('grass-meadow');
  const forest = channel('forest-floor');
  const dirt = channel('dirt-path');
  const hard = (['cobble-town', 'stone-arena', 'wood-warm'] as const).map(channel);
  // The footprint is centred on the transform, so half its diagonal reaches every corner at any yaw.
  const obstaclesNear = bucketIndex(blockingObstacles(inputs), rect, (obstacle) => Math.hypot(obstacle.rect.width, obstacle.rect.depth) / 2);
  const doors = [sector, ...inputs.neighbours].flatMap((each) =>
    each.doors.flatMap((door) => {
      const resolved = resolveDoor(each, door, inputs.registry);
      return resolved === undefined ? [] : [resolved];
    }),
  );
  const doorsNear = bucketIndex(doors, rect, (door) => {
    // The trigger as `clear` tests it: grown by the player's radius on every side.
    const r = SOMNIO_CONSTANTS.playerRadius;
    const { x, z, width, depth } = door.trigger;
    const corner = Math.max(
      Math.hypot(x - r, z - r),
      Math.hypot(x + width + r, z - r),
      Math.hypot(x - r, z + depth + r),
      Math.hypot(x + width + r, z + depth + r),
    );
    return Math.max(corner, distance(door.arrival, door.transform) + ARRIVAL_CLEARANCE);
  });
  const clear = (point: Point): boolean =>
    !obstaclesNear(point).some((obstacle) => rectContains(obstacle.rect, worldToModel(obstacle.transform, point))) &&
    !doorsNear(point).some(
      (door) =>
        rectContains(door.trigger, worldToModel(door.transform, point), SOMNIO_CONSTANTS.playerRadius) ||
        Math.hypot(point.x - door.arrival.x, point.z - door.arrival.z) < ARRIVAL_CLEARANCE,
    );

  const scatter: Scatter = { tufts: [], pebbles: [], flowers: [] };
  const columns = Math.floor(rect.width / CELL_METRES);
  const rows = Math.floor(rect.depth / CELL_METRES);
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < columns; i += 1) {
      const roll = (n: number): number => hash2(i, j, seed + n * 7919);
      const point = { x: rect.x + (i + roll(0)) * CELL_METRES, z: rect.z + (j + roll(1)) * CELL_METRES };
      const weights = sampleGroundField(field, point.x, point.z);
      const paved = weights[dirt]! + hard.reduce((sum, index) => sum + weights[index]!, 0);
      // Nothing grows on a road or a plaza, only toward its feathered edge.
      if (Math.max(weights[dirt]!, ...hard.map((index) => weights[index]!)) > 0.5 || !clear(point)) continue;
      const open = Math.max(0, 1 - paved) ** 3;
      const clump = 0.35 + 1.3 * fbm(point.x * 0.35, point.z * 0.35, seed + 1);
      const yaw = roll(3) * 360;
      if (roll(2) < SCATTER_DENSITY * 0.5 * (weights[grass]! + 0.75 * weights[forest]!) * open * clump) {
        scatter.tufts.push({ modelId: GRASS_MODEL_IDS[Math.floor(roll(4) * GRASS_MODEL_IDS.length)]!, ...point, yaw });
      }
      const onPathEdge = weights[dirt]! > 0.12;
      if ((onPathEdge && roll(5) < SCATTER_DENSITY * 0.22) || (weights[forest]! > 0.6 && roll(5) < SCATTER_DENSITY * 0.03)) {
        scatter.pebbles.push({ modelId: PEBBLE_MODEL_ID, ...point, yaw });
      }
      if (weights[grass]! > 0.75 && open > 0.8 && roll(6) < SCATTER_DENSITY * 0.035 * clump) {
        const colour = FLOWER_COLOURS[Math.floor(roll(7) * FLOWER_COLOURS.length)]!;
        const heads = 3 + Math.floor(roll(8) * 3);
        for (let head = 0; head < heads; head += 1) {
          const at = { x: point.x + (roll(9 + head * 3) - 0.5) * 0.35, z: point.z + (roll(10 + head * 3) - 0.5) * 0.35 };
          if (rectContains(rect, at) && clear(at)) scatter.flowers.push({ ...at, colour, height: 0.08 + roll(11 + head * 3) * 0.05 });
        }
      }
    }
  }
  return scatter;
}

/** The footprints of every placement here and next door that blocks, as rects in each model's space. */
function blockingObstacles(inputs: ScatterInputs): Obstacle[] {
  return [inputs.sector, ...inputs.neighbours].flatMap((sector) => {
    const origin = sectorOrigin(sector);
    return sector.placements.flatMap((placement) => {
      const rule = objectModel(inputs.registry, placement.modelId);
      if (rule === undefined || (rule.colliders.length === 0 && rule.walkSurfaces.length === 0)) return [];
      const { width, depth } = rule.footprint;
      return [
        { transform: { x: origin.x + placement.x, z: origin.z + placement.z, yaw: placement.yaw }, rect: { x: -width / 2, z: -depth / 2, width, depth } },
      ];
    });
  });
}

/**
 * Files each item in every bucket of the sector that the circle of `reach` round its transform
 * covers, and answers the items of a point's bucket.
 */
function bucketIndex<T extends { transform: Transform }>(items: readonly T[], rect: Rect, reach: (item: T) => number): (point: Point) => readonly T[] {
  const columns = Math.max(1, Math.ceil(rect.width / BUCKET_METRES));
  const rows = Math.max(1, Math.ceil(rect.depth / BUCKET_METRES));
  const column = (x: number): number => clamp(Math.floor((x - rect.x) / BUCKET_METRES), 0, columns - 1);
  const row = (z: number): number => clamp(Math.floor((z - rect.z) / BUCKET_METRES), 0, rows - 1);
  const buckets: T[][] = Array.from({ length: columns * rows }, () => []);
  for (const item of items) {
    const { x, z } = item.transform;
    const radius = reach(item);
    if (x + radius < rect.x || x - radius > rect.x + rect.width || z + radius < rect.z || z - radius > rect.z + rect.depth) continue;
    for (let j = row(z - radius); j <= row(z + radius); j += 1)
      for (let i = column(x - radius); i <= column(x + radius); i += 1) buckets[j * columns + i]!.push(item);
  }
  return (point) => buckets[row(point.z) * columns + column(point.x)]!;
}
