import { describe, expect, it } from 'vitest';
import { bundledModelRegistry } from '../src/modelRegistry.ts';
import type { Sector } from '../src/sector.ts';
import { OUTDOOR_SPACE_ID, buildWorld, neighbourSectors } from '../src/world.ts';
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
    floorMaterialId: sector.floorMaterialId,
    counts: {
      placements: sector.placements.length,
      blockers: sector.blockers.length,
      doors: sector.doors.length,
      npcs: sector.npcs.length,
      monsterSpawns: sector.monsterSpawns.length,
      floorPatches: sector.floorPatches.length,
    },
    doors: Object.fromEntries(sector.doors.map((door) => [door.id, `${door.target.sector}/${door.target.door}`])),
    npcs: Object.fromEntries(sector.npcs.map((npc) => [npc.id, npc.characterModelId])),
  };
}

describe('the committed world', () => {
  it('is three outdoor lands and four interiors, each holding what it was authored with', () => {
    expect(Object.fromEntries(sectors.map((sector) => [sector.name, contents(sector)]))).toEqual({
      EdariaArena: {
        kind: 'interior',
        size: { width: 10.24, depth: 10.24 },
        brightness: 75,
        floorMaterialId: 'stone-arena',
        counts: { placements: 1, blockers: 2, doors: 1, npcs: 0, monsterSpawns: 1, floorPatches: 0 },
        doors: { exit: 'EdariaMitte/to-edariaarena' },
        npcs: {},
      },
      EdariaBibliothek: {
        kind: 'interior',
        size: { width: 10.24, depth: 10.24 },
        brightness: 100,
        floorMaterialId: 'wood-warm',
        counts: { placements: 33, blockers: 2, doors: 1, npcs: 1, monsterSpawns: 0, floorPatches: 0 },
        doors: { exit: 'EdariaMitte/to-edariabibliothek' },
        npcs: { libus: 'libus' },
      },
      EdariaInn: {
        kind: 'interior',
        size: { width: 5.12, depth: 5.12 },
        brightness: 100,
        floorMaterialId: 'wood-warm',
        counts: { placements: 18, blockers: 3, doors: 1, npcs: 1, monsterSpawns: 0, floorPatches: 0 },
        doors: { exit: 'EdariaMitte/to-edariainn' },
        npcs: { quieta: 'kraemer' },
      },
      EdariaMitte: {
        kind: 'outdoor',
        size: { width: 40.96, depth: 40.96 },
        origin: { x: 0, z: 0 },
        floorMaterialId: 'grass-meadow',
        counts: { placements: 92, blockers: 0, doors: 4, npcs: 1, monsterSpawns: 0, floorPatches: 3 },
        doors: {
          'to-edariabibliothek': 'EdariaBibliothek/exit',
          'to-edariaarena': 'EdariaArena/exit',
          'to-edariashop': 'EdariaShop/exit',
          'to-edariainn': 'EdariaInn/exit',
        },
        npcs: { pugnax: 'kaempfer-meister' },
      },
      EdariaShop: {
        kind: 'interior',
        size: { width: 5.12, depth: 5.12 },
        brightness: 100,
        floorMaterialId: 'wood-warm',
        counts: { placements: 22, blockers: 2, doors: 1, npcs: 1, monsterSpawns: 0, floorPatches: 0 },
        doors: { exit: 'EdariaMitte/to-edariashop' },
        npcs: { mercus: 'kraemer' },
      },
      Nordwald: {
        kind: 'outdoor',
        size: { width: 30.72, depth: 30.72 },
        origin: { x: 5.12, z: -61.44 },
        floorMaterialId: 'forest-floor',
        counts: { placements: 32, blockers: 0, doors: 0, npcs: 0, monsterSpawns: 1, floorPatches: 0 },
        doors: {},
        npcs: {},
      },
      Nordwiese: {
        kind: 'outdoor',
        size: { width: 30.72, depth: 30.72 },
        origin: { x: 5.12, z: -30.72 },
        floorMaterialId: 'grass-meadow',
        counts: { placements: 6, blockers: 0, doors: 0, npcs: 0, monsterSpawns: 0, floorPatches: 1 },
        doors: {},
        npcs: {},
      },
    });
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

  it('tiles the outdoor lands north of the town so their openings meet', () => {
    expect(byName.get('EdariaMitte')).toMatchObject({ origin: { x: 0, z: 0 }, size: { width: 40.96, depth: 40.96 } });
    expect(byName.get('Nordwiese')).toMatchObject({ origin: { x: 5.12, z: -30.72 }, size: { width: 30.72, depth: 30.72 } });
    expect(byName.get('Nordwald')).toMatchObject({ origin: { x: 5.12, z: -61.44 }, size: { width: 30.72, depth: 30.72 } });
  });

  it('builds with every door live, no collision issue, and a clear starter spawn', () => {
    const world = buildWorld(sectors, bundledModelRegistry());
    expect(world.issues).toEqual([]);
    expect(byName.get('EdariaBibliothek')?.spawn).toBeDefined();

    const outdoors = world.spaces.get(OUTDOOR_SPACE_ID)!;
    const neighbours = (name: string): string[] => neighbourSectors(outdoors, name).map((sector) => sector.name);
    expect(neighbours('EdariaMitte')).toEqual(['Nordwiese']);
    expect(neighbours('Nordwiese').sort()).toEqual(['EdariaMitte', 'Nordwald']);
    expect(neighbours('Nordwald')).toEqual(['Nordwiese']);
  });
});
