import { describe, expect, it } from 'vitest';
import { bundledModelRegistry } from '../src/modelRegistry.ts';
import type { Sector } from '../src/sector.ts';
import { OUTDOOR_SPACE_ID, buildWorld, neighbourSectors, resolveDoor } from '../src/world.ts';
import { loadSectorFixtures } from './support/sectorFixture.ts';

/**
 * What the committed sectors promise as a world. These fixtures are the world the image ships, so
 * a failure here is a broken door or a torn border in the live game.
 */

const sectors = loadSectorFixtures();
const byName = new Map(sectors.map((sector) => [sector.name, sector]));

/** What a sector holds, short enough to pin: its record counts, where each door leads, and which character model each NPC wears. */
function contents(sector: Sector): object {
  return {
    kind: sector.kind,
    size: sector.size,
    origin: sector.origin,
    brightness: sector.brightness,
    backgroundMaterialId: sector.ground.backgroundMaterialId,
    counts: {
      placements: sector.placements.length,
      blockers: sector.blockers.length,
      doors: sector.doors.length,
      npcs: sector.npcs.length,
      monsterSpawns: sector.monsterSpawns.length,
      marks: sector.ground.marks.length,
    },
    doors: Object.fromEntries(sector.doors.map((door) => [door.id, `${door.target.sector}/${door.target.door}`])),
    npcs: Object.fromEntries(sector.npcs.map((npc) => [npc.id, npc.characterModelId])),
  };
}

describe('the committed world', () => {
  it('is six outdoor lands and six interiors, each holding what it was authored with', () => {
    expect(Object.fromEntries(sectors.map((sector) => [sector.name, contents(sector)]))).toEqual({
      AutumnWood: {
        kind: 'outdoor',
        size: { width: 40.96, depth: 40.96 },
        origin: { x: 40.96, z: 0 },
        backgroundMaterialId: 'forest-floor',
        counts: { placements: 193, blockers: 0, doors: 0, npcs: 0, monsterSpawns: 2, marks: 4 },
        doors: {},
        npcs: {},
      },
      EdariaArena: {
        kind: 'interior',
        size: { width: 10.24, depth: 10.24 },
        brightness: 75,
        backgroundMaterialId: 'stone-arena',
        counts: { placements: 37, blockers: 2, doors: 1, npcs: 0, monsterSpawns: 1, marks: 1 },
        doors: { exit: 'EdariaSquare/to-edariaarena' },
        npcs: {},
      },
      EdariaFighterHall: {
        kind: 'interior',
        size: { width: 10.24, depth: 10.24 },
        brightness: 85,
        backgroundMaterialId: 'stone-arena',
        counts: { placements: 54, blockers: 2, doors: 1, npcs: 1, monsterSpawns: 0, marks: 0 },
        doors: { exit: 'EdariaSquare/to-edariafighterhall' },
        npcs: { pugnax: 'fighter-master' },
      },
      EdariaHealerHall: {
        kind: 'interior',
        size: { width: 7.68, depth: 7.68 },
        brightness: 100,
        backgroundMaterialId: 'wood-warm',
        counts: { placements: 38, blockers: 2, doors: 1, npcs: 1, monsterSpawns: 0, marks: 0 },
        doors: { exit: 'EdariaSquare/to-edariahealerhall' },
        npcs: { sana: 'merchant' },
      },
      EdariaInn: {
        kind: 'interior',
        size: { width: 5.12, depth: 5.12 },
        brightness: 100,
        backgroundMaterialId: 'wood-warm',
        counts: { placements: 38, blockers: 3, doors: 1, npcs: 1, monsterSpawns: 0, marks: 0 },
        doors: { exit: 'EdariaSquare/to-edariainn' },
        npcs: { quieta: 'merchant' },
      },
      EdariaLibrary: {
        kind: 'interior',
        size: { width: 10.24, depth: 10.24 },
        brightness: 100,
        backgroundMaterialId: 'wood-warm',
        counts: { placements: 69, blockers: 2, doors: 1, npcs: 1, monsterSpawns: 0, marks: 0 },
        doors: { exit: 'EdariaSquare/to-edarialibrary' },
        npcs: { libus: 'libus' },
      },
      EdariaShop: {
        kind: 'interior',
        size: { width: 5.12, depth: 5.12 },
        brightness: 100,
        backgroundMaterialId: 'wood-warm',
        counts: { placements: 42, blockers: 2, doors: 1, npcs: 1, monsterSpawns: 0, marks: 0 },
        doors: { exit: 'EdariaSquare/to-edariashop' },
        npcs: { mercus: 'merchant' },
      },
      EdariaSquare: {
        kind: 'outdoor',
        size: { width: 40.96, depth: 40.96 },
        origin: { x: 0, z: 0 },
        backgroundMaterialId: 'grass-meadow',
        counts: { placements: 150, blockers: 0, doors: 6, npcs: 0, monsterSpawns: 0, marks: 16 },
        doors: {
          'to-edarialibrary': 'EdariaLibrary/exit',
          'to-edariaarena': 'EdariaArena/exit',
          'to-edariashop': 'EdariaShop/exit',
          'to-edariainn': 'EdariaInn/exit',
          'to-edariafighterhall': 'EdariaFighterHall/exit',
          'to-edariahealerhall': 'EdariaHealerHall/exit',
        },
        npcs: {},
      },
      NorthMeadow: {
        kind: 'outdoor',
        size: { width: 30.72, depth: 30.72 },
        origin: { x: 5.12, z: -30.72 },
        backgroundMaterialId: 'grass-meadow',
        counts: { placements: 61, blockers: 0, doors: 0, npcs: 0, monsterSpawns: 0, marks: 4 },
        doors: {},
        npcs: {},
      },
      NorthWood: {
        kind: 'outdoor',
        size: { width: 30.72, depth: 30.72 },
        origin: { x: 5.12, z: -61.44 },
        backgroundMaterialId: 'forest-floor',
        counts: { placements: 148, blockers: 0, doors: 0, npcs: 0, monsterSpawns: 1, marks: 3 },
        doors: {},
        npcs: {},
      },
      SouthMeadow: {
        kind: 'outdoor',
        size: { width: 30.72, depth: 30.72 },
        origin: { x: 5.12, z: 40.96 },
        backgroundMaterialId: 'grass-meadow',
        counts: { placements: 71, blockers: 0, doors: 0, npcs: 0, monsterSpawns: 0, marks: 3 },
        doors: {},
        npcs: {},
      },
      WestMeadow: {
        kind: 'outdoor',
        size: { width: 30.72, depth: 30.72 },
        origin: { x: -30.72, z: 5.12 },
        backgroundMaterialId: 'grass-meadow',
        counts: { placements: 62, blockers: 0, doors: 0, npcs: 0, monsterSpawns: 0, marks: 3 },
        doors: {},
        npcs: {},
      },
    });
  });

  it('gives each master and the shopkeeper their service, and the inn a spawn to wake at', () => {
    const services = sectors.flatMap((sector) => sector.npcs.flatMap((npc) => (npc.service === undefined ? [] : [[`${sector.name}/${npc.id}`, npc.service]])));
    expect(Object.fromEntries(services)).toEqual({
      'EdariaFighterHall/pugnax': 'fighterMaster',
      'EdariaHealerHall/sana': 'healerMaster',
      'EdariaShop/mercus': 'shopkeeper',
    });
    expect(byName.get('EdariaInn')?.spawn).toBeDefined();
  });

  it('pairs every door with a door that points back', () => {
    const unpaired: string[] = [];
    for (const sector of sectors) {
      for (const door of sector.doors) {
        const target = byName.get(door.target.sector)?.doors.find((candidate) => candidate.id === door.target.door);
        if (target?.target.sector !== sector.name || target.target.door !== door.id) unpaired.push(`${sector.name}/${door.id}`);
      }
    }
    expect(unpaired).toEqual([]);
  });

  it('tiles the outdoor lands round the town so their openings meet its gates', () => {
    expect(byName.get('EdariaSquare')).toMatchObject({ origin: { x: 0, z: 0 }, size: { width: 40.96, depth: 40.96 } });
    expect(byName.get('NorthMeadow')).toMatchObject({ origin: { x: 5.12, z: -30.72 }, size: { width: 30.72, depth: 30.72 } });
    expect(byName.get('NorthWood')).toMatchObject({ origin: { x: 5.12, z: -61.44 }, size: { width: 30.72, depth: 30.72 } });
    expect(byName.get('WestMeadow')).toMatchObject({ origin: { x: -30.72, z: 5.12 }, size: { width: 30.72, depth: 30.72 } });
    expect(byName.get('SouthMeadow')).toMatchObject({ origin: { x: 5.12, z: 40.96 }, size: { width: 30.72, depth: 30.72 } });
    expect(byName.get('AutumnWood')).toMatchObject({ origin: { x: 40.96, z: 0 }, size: { width: 40.96, depth: 40.96 } });
  });

  /** No land is a lattice of one model: each mixes trees, bushes, and rocks, turned more than one way. */
  it.each(['NorthMeadow', 'SouthMeadow', 'WestMeadow', 'NorthWood', 'AutumnWood'])('dresses %s with a mix of trees, bushes, and rocks', (name) => {
    const placements = byName.get(name)!.placements;
    const models = new Set(placements.map((placement) => placement.modelId));
    const of = (kind: string): string[] =>
      [...models].filter((model) => (kind === 'tree' ? model.includes('tree') || model.includes('pine') : model.startsWith(kind)));
    expect(of('tree').length).toBeGreaterThanOrEqual(3);
    expect(of('bush').length).toBeGreaterThanOrEqual(1);
    expect(of('rock').length).toBeGreaterThanOrEqual(1);
    expect(new Set(placements.map((placement) => placement.yaw)).size).toBeGreaterThan(1);
  });

  it('places every nature model the registry holds somewhere', () => {
    const placed = new Set(sectors.flatMap((sector) => sector.placements.map((placement) => placement.modelId)));
    const nature = bundledModelRegistry()
      .objectModels.map((rule) => rule.id)
      .filter((id) => /^(tree-|autumn-pine-|pine-tree|bush-|rock-)/.test(id));
    expect(nature.filter((id) => !placed.has(id))).toEqual([]);
  });

  /** The camera looks in over the low front walls, and the door stands in a gap in them. */
  it.each(['EdariaArena', 'EdariaFighterHall', 'EdariaHealerHall', 'EdariaInn', 'EdariaLibrary', 'EdariaShop'])(
    'walls %s on all four sides with a gap at its door',
    (name) => {
      const room = byName.get(name)!;
      const { width, depth } = room.size;
      const walls = room.placements.filter((placement) => placement.modelId.includes('-room-'));
      const side = (test: (x: number, z: number) => boolean): string[] => walls.filter((wall) => test(wall.x, wall.z)).map((wall) => wall.modelId);
      const north = side((x, z) => z < 0 && x > 0 && x < width);
      const west = side((x, z) => x < 0 && z > 0 && z < depth);
      const south = side((x, z) => z > depth && x > 0 && x < width);
      const east = side((x, z) => x > width && z > 0 && z < depth);
      for (const full of [north, west]) {
        expect(full.length).toBeGreaterThan(0);
        for (const model of full) expect(model).not.toMatch(/-low$/);
      }
      for (const low of [south, east]) {
        expect(low.length).toBeGreaterThan(0);
        for (const model of low) expect(model).toMatch(/-low$/);
      }
      const doorway = resolveDoor(room, room.doors[0]!, bundledModelRegistry())!.doorway;
      expect(walls.filter((wall) => Math.hypot(wall.x - doorway.x, wall.z - doorway.z) < 1.2)).toEqual([]);
    },
  );

  it('builds with every door live, no collision issue, and a clear starter spawn', () => {
    const world = buildWorld(sectors, bundledModelRegistry());
    expect(world.issues).toEqual([]);
    expect(byName.get('EdariaLibrary')?.spawn).toBeDefined();

    const outdoors = world.spaces.get(OUTDOOR_SPACE_ID)!;
    const neighbours = (name: string): string[] => neighbourSectors(outdoors, name).map((sector) => sector.name);
    expect(neighbours('EdariaSquare')).toEqual(['AutumnWood', 'NorthMeadow', 'SouthMeadow', 'WestMeadow']);
    expect(neighbours('NorthMeadow')).toEqual(['EdariaSquare', 'NorthWood']);
    expect(neighbours('NorthWood')).toEqual(['NorthMeadow']);
    for (const land of ['WestMeadow', 'SouthMeadow', 'AutumnWood']) expect(neighbours(land)).toEqual(['EdariaSquare']);
  });
});
