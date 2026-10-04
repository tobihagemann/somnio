import { parseModelRegistry } from '../../src/modelRegistry.ts';
import type { Sector } from '../../src/sector.ts';

/** A sector with no content; every test names only what it is about. */
export function outdoorSector(name: string, origin: { x: number; z: number }, overrides: Partial<Sector> = {}): Sector {
  return {
    name,
    kind: 'outdoor',
    origin,
    size: { width: 20, depth: 20 },
    floorMaterialId: 'grass',
    floorPatches: [],
    placements: [],
    blockers: [],
    doors: [],
    npcs: [],
    monsterSpawns: [],
    ...overrides,
  };
}

export function interiorSector(name: string, overrides: Partial<Sector> = {}): Sector {
  return {
    name,
    kind: 'interior',
    brightness: 100,
    size: { width: 10, depth: 10 },
    floorMaterialId: 'grass',
    floorPatches: [],
    placements: [],
    blockers: [],
    doors: [],
    npcs: [],
    monsterSpawns: [],
    ...overrides,
  };
}

const prop = (stem: string) => ({ stem, expectedClips: [] });

/**
 * `hall` is shaped like the townhall, door side +X: a body, a porch along its front, and a stair
 * run cut into the porch's edge, so the landing and the three treads share the porch's height or
 * step down from it. `box` blocks by its footprint, `rug` never blocks, and `door` is the interior
 * door, opening toward -Z.
 */
export const TEST_REGISTRY = parseModelRegistry({
  characterModels: [
    { id: 'hero', model: { stem: 'Hero', expectedClips: ['Idle'] } },
    { id: 'ghost', model: { stem: 'Ghost', expectedClips: ['Flying_Idle'] } },
  ],
  playerModel: 'hero',
  floorMaterials: [
    { id: 'grass', stem: 'Grass' },
    { id: 'cobble', stem: 'Cobble' },
  ],
  objectModels: [
    { id: 'box', model: prop('Box'), footprint: { width: 2, depth: 1 } },
    { id: 'rug', model: prop('Rug'), footprint: { width: 2, depth: 1 }, colliders: [] },
    { id: 'door', model: prop('Door'), footprint: { width: 1.92, depth: 0.19 }, colliders: [], doors: [{ id: 'main', x: 0, z: 0, facing: 180, width: 1.54 }] },
    { id: 'dais', model: prop('Dais'), footprint: { width: 2, depth: 2 }, colliders: [], walkSurfaces: [{ x: -1, z: -1, width: 2, depth: 2, height: 0.2 }] },
    { id: 'stage', model: prop('Stage'), footprint: { width: 2, depth: 2 }, colliders: [], walkSurfaces: [{ x: -1, z: -1, width: 2, depth: 2, height: 0.25 }] },
    {
      id: 'hall',
      model: prop('Hall'),
      footprint: { width: 7.68, depth: 7.05 },
      colliders: [
        { x: -3.9, z: -3.5, width: 5.32, depth: 7 },
        { x: 1.42, z: -3.5, width: 1.08, depth: 3.23 },
      ],
      walkSurfaces: [
        { x: 1.42, z: -0.27, width: 1, depth: 3.62, height: 1.03 },
        { x: 2.42, z: 0.04, width: 0.4, depth: 1.72, height: 1.03 },
        { x: 2.82, z: 0.04, width: 0.35, depth: 1.72, height: 0.77 },
        { x: 3.17, z: 0.04, width: 0.33, depth: 1.72, height: 0.52 },
        { x: 3.5, z: 0.04, width: 0.35, depth: 1.72, height: 0.26 },
      ],
      doors: [{ id: 'main', x: 1.42, z: 0.9, facing: 90, width: 1.52 }],
    },
  ],
});
