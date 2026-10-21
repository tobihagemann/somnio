import { describe, expect, it } from 'vitest';
import { SECTOR_BORDER_SUPPORT_METRES, SOMNIO_CONSTANTS, bundledModelRegistry, objectModel, rectContains, resolveDoor, worldToModel } from '@somnio/core';
import type { SectorView } from '@somnio/protocol';
import { rasterizeGround, sampleGroundField } from '@/scene/groundField';
import { GROUND_MATERIAL_IDS } from '@/scene/groundMaterials';
import { scatterSector } from '@/scene/scatter';
import type { Scatter } from '@/scene/scatter';
import { outdoorSector } from '../../core/test/support/worldFixture.ts';

/** What grows on the ground: placed by seed, so the same inputs grow the same, and kept off what blocks, the doors, and the paving. */

const registry = bundledModelRegistry();

const meadow = (): SectorView =>
  outdoorSector(
    'Meadow',
    { x: 0, z: 0 },
    {
      size: { width: 20, depth: 20 },
      ground: {
        backgroundMaterialId: 'grass-meadow',
        marks: [
          {
            id: 'road',
            materialId: 'dirt-path',
            opacity: 1,
            shape: {
              kind: 'stroke',
              radius: 1.2,
              points: [
                { x: 2, z: 10 },
                { x: 18, z: 12 },
              ],
            },
          },
          {
            id: 'plaza',
            materialId: 'cobble-town',
            opacity: 1,
            shape: {
              kind: 'polygon',
              points: [
                { x: 3, z: 2 },
                { x: 7, z: 2 },
                { x: 7, z: 6 },
                { x: 3, z: 6 },
              ],
            },
          },
        ],
      },
      placements: [
        { id: 'house', modelId: 'building-house', x: 15.9, z: 5.9, yaw: 270, elevation: 0 },
        { id: 'oak', modelId: 'tree-1-b', x: 5, z: 16, yaw: 30, elevation: 0 },
        // Blocks nothing, so only the door scan keeps the grass off its trigger, which crosses a bucket's edge.
        { id: 'cellar', modelId: 'door', x: 9.9, z: 15.9, yaw: 0, elevation: 0 },
      ],
      doors: [
        { id: 'to-shop', placement: 'house', anchor: 'main', target: { sector: 'Shop', door: 'exit' } },
        { id: 'to-cellar', placement: 'cellar', anchor: 'main', target: { sector: 'Cellar', door: 'exit' } },
      ],
    },
  );
const wood = (): SectorView =>
  outdoorSector(
    'Wood',
    { x: 20, z: 0 },
    {
      size: { width: 20, depth: 20 },
      ground: { backgroundMaterialId: 'forest-floor', marks: [] },
      placements: [{ id: 'oak', modelId: 'tree-1-c', x: 0.4, z: 15, yaw: 0, elevation: 0 }],
    },
  );
/** Neighbours to the north and west, each with a tree whose footprint crosses into the meadow. */
const north = (): SectorView =>
  outdoorSector(
    'North',
    { x: 0, z: -20 },
    {
      size: { width: 20, depth: 20 },
      ground: { backgroundMaterialId: 'grass-meadow', marks: [] },
      placements: [{ id: 'oak', modelId: 'tree-1-b', x: 10, z: 19.8, yaw: 0, elevation: 0 }],
    },
  );
const west = (): SectorView =>
  outdoorSector(
    'West',
    { x: -20, z: 0 },
    {
      size: { width: 20, depth: 20 },
      ground: { backgroundMaterialId: 'grass-meadow', marks: [] },
      placements: [{ id: 'oak', modelId: 'tree-1-c', x: 19.8, z: 6, yaw: 0, elevation: 0 }],
    },
  );

function grow(sector: SectorView, neighbours: SectorView[]): Scatter {
  return scatterSector({ sector, neighbours, field: rasterizeGround({ sector, neighbours }), registry });
}

describe('scatter', () => {
  it('grows the same from the same sector and neighbours', () => {
    const first = grow(meadow(), [wood()]);
    expect(first.tufts.length).toBeGreaterThan(100);
    expect(first.flowers.length).toBeGreaterThan(0);
    expect(first.pebbles.length).toBeGreaterThan(0);
    expect(grow(meadow(), [wood()])).toEqual(first);
  });

  it('changes only near the border when a neighbour leaves', () => {
    const key = (scatter: Scatter): Set<string> => new Set([...scatter.tufts, ...scatter.pebbles, ...scatter.flowers].map((item) => `${item.x},${item.z}`));
    const withWood = key(grow(meadow(), [wood()]));
    const alone = key(grow(meadow(), []));
    const differing = [...withWood].filter((item) => !alone.has(item)).concat([...alone].filter((item) => !withWood.has(item)));
    expect(differing.length).toBeGreaterThan(0);
    for (const item of differing) expect(Number(item.split(',')[0])).toBeGreaterThan(20 - SECTOR_BORDER_SUPPORT_METRES);
  });

  it('keeps off the paving, the footprints that block, and the door triggers, here and next door', () => {
    const sector = meadow();
    const neighbours = [wood(), north(), west()];
    const field = rasterizeGround({ sector, neighbours });
    const scatter = scatterSector({ sector, neighbours, field, registry });
    const paved = (['dirt-path', 'cobble-town'] as const).map((id) => GROUND_MATERIAL_IDS.indexOf(id));
    const blocking = [sector, ...neighbours].flatMap((each) =>
      each.placements.map((placement) => ({
        transform: { x: each.origin!.x + placement.x, z: each.origin!.z + placement.z, yaw: placement.yaw },
        rule: objectModel(registry, placement.modelId)!,
      })),
    );
    const doors = sector.doors.map((door) => resolveDoor(sector, door, registry)!);
    for (const item of [...scatter.tufts, ...scatter.pebbles, ...scatter.flowers]) {
      const weights = sampleGroundField(field, item.x, item.z);
      for (const index of paved) expect(weights[index]).toBeLessThanOrEqual(0.5);
      for (const { transform, rule } of blocking) {
        const { width, depth } = rule.footprint;
        expect(rectContains({ x: -width / 2, z: -depth / 2, width, depth }, worldToModel(transform, item))).toBe(false);
      }
      for (const door of doors) {
        expect(rectContains(door.trigger, worldToModel(door.transform, item), SOMNIO_CONSTANTS.playerRadius)).toBe(false);
        expect(Math.hypot(item.x - door.arrival.x, item.z - door.arrival.z)).toBeGreaterThanOrEqual(0.5);
      }
    }
  });
});
