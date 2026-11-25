import { describe, expect, it } from 'vitest';
import { buildSpaceCollision, canStand, isLegalMove, npcBodies } from '../src/collision.ts';
import { SOMNIO_CONSTANTS } from '../src/constants.ts';
import { EDGE_TOLERANCE, distance, distanceToRect, rectContains, rectDistance } from '../src/geometry.ts';
import type { Point } from '../src/geometry.ts';
import { bundledModelRegistry, objectModel } from '../src/modelRegistry.ts';
import { TELEGRAPHS, monsterKind } from '../src/monsterKinds.ts';
import { findPath, rasterizeWalkable, walkRasterInputs } from '../src/pathfinding.ts';
import { quest, reachedAt } from '../src/quests.ts';
import { sectorPointInSpace, sectorRect, spawnArea } from '../src/sector.ts';
import type { Sector } from '../src/sector.ts';
import { OUTDOOR_SPACE_ID, buildWorld, doorContains, neighbourSectors, resolveDoor, sectorAt } from '../src/world.ts';
import { loadSectorFixtures } from './support/sectorFixture.ts';

/**
 * What the committed sectors promise as a world. These fixtures are the world the image ships, so
 * a failure here is a broken door or a torn border in the live game.
 */

const sectors = loadSectorFixtures();
const byName = new Map(sectors.map((sector) => [sector.name, sector]));
const world = buildWorld(sectors, bundledModelRegistry());

/** Whether a dreamer standing at `start` in the room `name` walks, round whatever blocks, to a point `arrived` accepts. */
function walksInRoom(name: string, start: Point, arrived: (point: Point) => boolean): boolean {
  const space = world.spaces.get(name)!;
  const collision = buildSpaceCollision(space, bundledModelRegistry());
  const npcs = npcBodies(space);
  const step = 0.1;
  const key = (point: Point): string => `${Math.round(point.x / step)},${Math.round(point.z / step)}`;
  const seen = new Set([key(start)]);
  const queue = [start];
  for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
    if (arrived(at)) return true;
    for (const [dx, dz] of [
      [step, 0],
      [-step, 0],
      [0, step],
      [0, -step],
    ] as const) {
      const next = { x: at.x + dx, z: at.z + dz };
      if (seen.has(key(next))) continue;
      seen.add(key(next));
      if (canStand(collision, next, npcs) && isLegalMove(collision, at, next, SOMNIO_CONSTANTS.playerRadius, npcs)) queue.push(next);
    }
  }
  return false;
}

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
  it('is seven outdoor lands and nine interiors, each holding what it was authored with', () => {
    expect(Object.fromEntries(sectors.map((sector) => [sector.name, contents(sector)]))).toEqual({
      AutumnWood: {
        kind: 'outdoor',
        size: { width: 40.96, depth: 40.96 },
        origin: { x: 40.96, z: 0 },
        backgroundMaterialId: 'leaf-litter',
        counts: { placements: 170, blockers: 0, doors: 0, npcs: 0, monsterSpawns: 3, marks: 4 },
        doors: {},
        npcs: {},
      },
      EdariaArena: {
        kind: 'interior',
        size: { width: 10.24, depth: 10.24 },
        brightness: 75,
        backgroundMaterialId: 'stone-arena',
        counts: { placements: 62, blockers: 0, doors: 1, npcs: 0, monsterSpawns: 1, marks: 0 },
        doors: { exit: 'EdariaSquare/to-edariaarena' },
        npcs: {},
      },
      EdariaFighterHall: {
        kind: 'interior',
        size: { width: 7.68, depth: 7.68 },
        brightness: 85,
        backgroundMaterialId: 'stone-arena',
        counts: { placements: 57, blockers: 0, doors: 1, npcs: 1, monsterSpawns: 0, marks: 0 },
        doors: { exit: 'EdariaSquare/to-edariafighterhall' },
        npcs: { pugnax: 'fighter-master' },
      },
      EdariaHealerHall: {
        kind: 'interior',
        size: { width: 7.68, depth: 7.68 },
        brightness: 100,
        backgroundMaterialId: 'wood-warm',
        counts: { placements: 58, blockers: 0, doors: 1, npcs: 1, monsterSpawns: 0, marks: 0 },
        doors: { exit: 'EdariaSquare/to-edariahealerhall' },
        npcs: { sana: 'healer-master' },
      },
      EdariaInn: {
        kind: 'interior',
        size: { width: 7.68, depth: 7.68 },
        brightness: 100,
        backgroundMaterialId: 'wood-warm',
        counts: { placements: 64, blockers: 0, doors: 1, npcs: 1, monsterSpawns: 0, marks: 0 },
        doors: { exit: 'EdariaSquare/to-edariainn' },
        npcs: { quieta: 'merchant' },
      },
      EdariaLibrary: {
        kind: 'interior',
        size: { width: 7.68, depth: 7.68 },
        brightness: 100,
        backgroundMaterialId: 'wood-warm',
        counts: { placements: 50, blockers: 0, doors: 1, npcs: 1, monsterSpawns: 0, marks: 0 },
        doors: { exit: 'EdariaSquare/to-edarialibrary' },
        npcs: { libus: 'libus' },
      },
      EdariaMysticTower: {
        kind: 'interior',
        size: { width: 5.12, depth: 5.12 },
        brightness: 70,
        backgroundMaterialId: 'stone-arena',
        counts: { placements: 36, blockers: 0, doors: 1, npcs: 1, monsterSpawns: 0, marks: 0 },
        doors: { exit: 'EdariaSquare/to-edariamystictower' },
        npcs: { tacita: 'mystic-master' },
      },
      EdariaShop: {
        kind: 'interior',
        size: { width: 5.12, depth: 5.12 },
        brightness: 100,
        backgroundMaterialId: 'wood-warm',
        counts: { placements: 37, blockers: 0, doors: 1, npcs: 1, monsterSpawns: 0, marks: 0 },
        doors: { exit: 'EdariaSquare/to-edariashop' },
        npcs: { mercus: 'merchant' },
      },
      EdariaSquare: {
        kind: 'outdoor',
        size: { width: 40.96, depth: 40.96 },
        origin: { x: 0, z: 0 },
        backgroundMaterialId: 'grass-meadow',
        counts: { placements: 122, blockers: 0, doors: 7, npcs: 0, monsterSpawns: 0, marks: 21 },
        doors: {
          'to-edarialibrary': 'EdariaLibrary/exit',
          'to-edariaarena': 'EdariaArena/exit',
          'to-edariashop': 'EdariaShop/exit',
          'to-edariainn': 'EdariaInn/exit',
          'to-edariafighterhall': 'EdariaFighterHall/exit',
          'to-edariahealerhall': 'EdariaHealerHall/exit',
          'to-edariamystictower': 'EdariaMysticTower/exit',
        },
        npcs: {},
      },
      Graveyard: {
        kind: 'outdoor',
        size: { width: 40.96, depth: 40.96 },
        origin: { x: -71.68, z: 0 },
        backgroundMaterialId: 'forest-floor',
        counts: { placements: 267, blockers: 0, doors: 1, npcs: 1, monsterSpawns: 2, marks: 4 },
        doors: { 'to-graveyardcrypt': 'GraveyardCrypt/exit' },
        npcs: { memor: 'libus' },
      },
      GraveyardBurialChamber: {
        kind: 'interior',
        size: { width: 15.36, depth: 11.52 },
        brightness: 35,
        backgroundMaterialId: 'stone-arena',
        counts: { placements: 67, blockers: 0, doors: 1, npcs: 0, monsterSpawns: 1, marks: 0 },
        doors: { exit: 'GraveyardCrypt/to-graveyardburialchamber' },
        npcs: {},
      },
      GraveyardCrypt: {
        kind: 'interior',
        size: { width: 15.36, depth: 10.24 },
        brightness: 40,
        backgroundMaterialId: 'stone-arena',
        counts: { placements: 67, blockers: 0, doors: 2, npcs: 0, monsterSpawns: 2, marks: 0 },
        doors: { exit: 'Graveyard/to-graveyardcrypt', 'to-graveyardburialchamber': 'GraveyardBurialChamber/exit' },
        npcs: {},
      },
      NorthMeadow: {
        kind: 'outdoor',
        size: { width: 30.72, depth: 30.72 },
        origin: { x: 5.12, z: -30.72 },
        backgroundMaterialId: 'grass-meadow',
        counts: { placements: 47, blockers: 0, doors: 0, npcs: 0, monsterSpawns: 1, marks: 4 },
        doors: {},
        npcs: {},
      },
      NorthWood: {
        kind: 'outdoor',
        size: { width: 30.72, depth: 30.72 },
        origin: { x: 5.12, z: -61.44 },
        backgroundMaterialId: 'forest-floor',
        counts: { placements: 139, blockers: 0, doors: 0, npcs: 0, monsterSpawns: 2, marks: 3 },
        doors: {},
        npcs: {},
      },
      SouthMeadow: {
        kind: 'outdoor',
        size: { width: 30.72, depth: 30.72 },
        origin: { x: 5.12, z: 40.96 },
        backgroundMaterialId: 'grass-meadow',
        counts: { placements: 62, blockers: 0, doors: 0, npcs: 0, monsterSpawns: 1, marks: 3 },
        doors: {},
        npcs: {},
      },
      WestMeadow: {
        kind: 'outdoor',
        size: { width: 30.72, depth: 30.72 },
        origin: { x: -30.72, z: 5.12 },
        backgroundMaterialId: 'grass-meadow',
        counts: { placements: 61, blockers: 0, doors: 0, npcs: 0, monsterSpawns: 1, marks: 3 },
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
      'EdariaMysticTower/tacita': 'mysticMaster',
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

  /** Only the night shuts a door, and only from outside: a dreamer inside a room it shuts can always leave. */
  it('shuts only the tower from outside by day, and never a door out of a room', () => {
    const nightOnly = sectors.flatMap((sector) => sector.doors.filter((door) => door.nightOnly === true).map((door) => `${sector.name}/${door.id}`));
    expect(nightOnly).toEqual(['EdariaSquare/to-edariamystictower']);
  });

  it('tiles the outdoor lands round the town so their openings meet its gates', () => {
    expect(byName.get('EdariaSquare')).toMatchObject({ origin: { x: 0, z: 0 }, size: { width: 40.96, depth: 40.96 } });
    expect(byName.get('NorthMeadow')).toMatchObject({ origin: { x: 5.12, z: -30.72 }, size: { width: 30.72, depth: 30.72 } });
    expect(byName.get('NorthWood')).toMatchObject({ origin: { x: 5.12, z: -61.44 }, size: { width: 30.72, depth: 30.72 } });
    expect(byName.get('WestMeadow')).toMatchObject({ origin: { x: -30.72, z: 5.12 }, size: { width: 30.72, depth: 30.72 } });
    expect(byName.get('SouthMeadow')).toMatchObject({ origin: { x: 5.12, z: 40.96 }, size: { width: 30.72, depth: 30.72 } });
    expect(byName.get('AutumnWood')).toMatchObject({ origin: { x: 40.96, z: 0 }, size: { width: 40.96, depth: 40.96 } });
    expect(byName.get('Graveyard')).toMatchObject({ origin: { x: -71.68, z: 0 }, size: { width: 40.96, depth: 40.96 } });
  });

  /** No land is a lattice of one model: each mixes trees, bushes, and rocks, turned more than one way. */
  it.each(['NorthMeadow', 'SouthMeadow', 'WestMeadow', 'NorthWood', 'AutumnWood', 'Graveyard'])('dresses %s with a mix of trees, bushes, and rocks', (name) => {
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

  /** The camera looks in over the low front walls, and the door is a threshold of the room's wall set in a gap in them. */
  it.each([
    'EdariaArena',
    'EdariaFighterHall',
    'EdariaHealerHall',
    'EdariaInn',
    'EdariaLibrary',
    'EdariaMysticTower',
    'EdariaShop',
    'GraveyardBurialChamber',
    'GraveyardCrypt',
  ])('walls %s on all four sides with a gap at its door', (name) => {
    const room = byName.get(name)!;
    const { width, depth } = room.size;
    const door = room.placements.find((placement) => placement.id === room.doors[0]!.placement)!;
    expect(door.modelId).toBe(
      ['EdariaFighterHall', 'EdariaMysticTower', 'GraveyardBurialChamber', 'GraveyardCrypt'].includes(name) ? 'stone-room-threshold' : 'timber-room-threshold',
    );
    const walls = room.placements.filter((placement) => placement.modelId.includes('-room-') && !placement.modelId.endsWith('-threshold'));
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
  });

  /** Collision comes from the registry's colliders, which the game never draws, so a room whose furniture walls its keeper off would still look fine. */
  it.each(['EdariaFighterHall', 'EdariaHealerHall', 'EdariaInn', 'EdariaLibrary', 'EdariaMysticTower', 'EdariaShop'])(
    'lets a dreamer walk from the door of %s to its keeper',
    (name) => {
      const registry = bundledModelRegistry();
      const room = byName.get(name)!;
      const keeper = room.npcs[0]!;
      const reachesKeeper = (start: Point): boolean =>
        walksInRoom(name, start, (at) => Math.hypot(at.x - keeper.x, at.z - keeper.z) <= SOMNIO_CONSTANTS.speakingDistance);
      expect(reachesKeeper(resolveDoor(room, room.doors[0]!, registry)!.arrival)).toBe(true);
      if (room.spawn !== undefined) expect(reachesKeeper(room.spawn)).toBe(true);
    },
  );

  /** A new dreamer joins at the starter spawn, so with the spawn within Libus's speaking distance, Libus would greet every one as they arrive. */
  it('starts a fresh dreamer beyond the speaking distance of Libus', () => {
    const library = byName.get('EdariaLibrary')!;
    const libus = library.npcs.find((npc) => npc.id === 'libus')!;
    expect(Math.hypot(library.spawn!.x - libus.x, library.spawn!.z - libus.z)).toBeGreaterThan(SOMNIO_CONSTANTS.speakingDistance);
  });

  /** A dreamer anywhere on the boarded refuge stands beyond the notice of a ghost at rest in its spawn area. */
  it("keeps the Arena's boarded refuge out of every ghost's notice", () => {
    const arena = byName.get('EdariaArena')!;
    const boards = arena.placements.filter((placement) => placement.modelId === 'floor-boards');
    const refugeEdge = Math.min(...boards.map((board) => board.x - objectModel(bundledModelRegistry(), board.modelId)!.footprint.width / 2));
    expect(refugeEdge).toBeCloseTo(7.68, 9);
    for (const spawn of arena.monsterSpawns) {
      const area = spawnArea(arena, spawn);
      expect(refugeEdge - SOMNIO_CONSTANTS.playerRadius - (area.x + area.width)).toBeGreaterThan(monsterKind(spawn.kind).aggroRadius);
    }
  });

  it("keeps skeletons among the Graveyard's graves", () => {
    const graveyard = byName.get('Graveyard')!;
    expect(graveyard.monsterSpawns.map((spawn) => spawn.kind).toSorted()).toEqual(['skeleton-minion', 'skeleton-warrior']);
    for (const spawn of graveyard.monsterSpawns) {
      const area = { x: spawn.x, z: spawn.z, width: spawn.width, depth: spawn.depth };
      expect(
        graveyard.placements.filter((placement) => placement.modelId.startsWith('grave') && rectContains(area, placement)).length,
        spawn.id,
      ).toBeGreaterThanOrEqual(6);
    }
  });

  it("lets a dreamer walk from the West Meadow's road through the Graveyard's arch to the crypt's door", () => {
    const registry = bundledModelRegistry();
    const outdoors = world.spaces.get(OUTDOOR_SPACE_ID)!;
    const collision = buildSpaceCollision(outdoors, registry);
    const grid = { collision, rasters: outdoors.sectors.map((sector) => rasterizeWalkable(walkRasterInputs(collision, sector))) };
    const from = sectorPointInSpace(byName.get('WestMeadow')!, { x: 6, z: 15.28 });
    const graveyard = byName.get('Graveyard')!;
    const crypt = resolveDoor(graveyard, graveyard.doors[0]!, registry)!;
    const path = findPath(grid, from, crypt.arrival, npcBodies(outdoors), new Set());
    expect(distance(path.waypoints.at(-1) ?? from, crypt.arrival)).toBeLessThan(0.01);
  });

  /** Memor gives his quests to whoever speaks with him, so no skeleton at rest may notice a dreamer standing within his speaking distance. */
  it("stands Memor by the Graveyard's church, a walk from the road, beyond every skeleton's notice of a dreamer speaking with him", () => {
    const graveyard = byName.get('Graveyard')!;
    const memor = graveyard.npcs.find((npc) => npc.id === 'memor')!;
    for (const spawn of graveyard.monsterSpawns) {
      const area = { x: spawn.x, z: spawn.z, width: spawn.width, depth: spawn.depth };
      expect(distanceToRect(memor, area) - SOMNIO_CONSTANTS.speakingDistance - EDGE_TOLERANCE, spawn.id).toBeGreaterThan(monsterKind(spawn.kind).aggroRadius);
    }
    const registry = bundledModelRegistry();
    const outdoors = world.spaces.get(OUTDOOR_SPACE_ID)!;
    const collision = buildSpaceCollision(outdoors, registry);
    const grid = { collision, rasters: outdoors.sectors.map((sector) => rasterizeWalkable(walkRasterInputs(collision, sector))) };
    const from = sectorPointInSpace(byName.get('WestMeadow')!, { x: 6, z: 15.28 });
    const beforeMemor = sectorPointInSpace(graveyard, { x: memor.x, z: memor.z + 1 });
    const path = findPath(grid, from, beforeMemor, npcBodies(outdoors), new Set());
    expect(distance(path.waypoints.at(-1) ?? from, beforeMemor)).toBeLessThan(0.01);
  });

  /** A dreamer crossing into a land, or standing at one of Tacita's hidden places, stands beyond the notice of every nightmare at rest in its spawn area. */
  it.each(['NorthWood', 'AutumnWood', 'NorthMeadow', 'SouthMeadow', 'WestMeadow'])(
    "keeps every nightmare of %s beyond notice of the edges it shares and of Tacita's hidden places there",
    (name) => {
      const land = byName.get(name)!;
      const neighbours = neighbourSectors(world.spaces.get(OUTDOOR_SPACE_ID)!, name);
      const places = quest('mystic-trial').objectives.flatMap((objective) =>
        objective.kind === 'reach' && objective.sector === name && objective.place !== undefined ? [objective.place] : [],
      );
      for (const spawn of land.monsterSpawns) {
        const area = spawnArea(land, spawn);
        const notice = monsterKind(spawn.kind).aggroRadius;
        for (const neighbour of neighbours) expect(rectDistance(area, sectorRect(neighbour)), `${spawn.id} by ${neighbour.name}`).toBeGreaterThan(notice);
        for (const place of places) {
          expect(
            distanceToRect(sectorPointInSpace(land, place), area) - place.radius - EDGE_TOLERANCE,
            `${spawn.id} by (${place.x}, ${place.z})`,
          ).toBeGreaterThan(notice);
        }
      }
    },
  );

  it('lets a dreamer walk through the crypt hall from the Graveyard to the burial chamber', () => {
    const registry = bundledModelRegistry();
    const hall = byName.get('GraveyardCrypt')!;
    const [exit, deeper] = hall.doors.map((door) => resolveDoor(hall, door, registry)!);
    expect(walksInRoom('GraveyardCrypt', exit!.arrival, (at) => doorContains(deeper!, at, 0))).toBe(true);
  });

  /** The Necromancer wails round where it stands, anywhere in its chamber, so a dreamer arriving in its chamber stands beyond the wail. */
  it("keeps the burial chamber's door beyond the Necromancer's wail", () => {
    const chamber = byName.get('GraveyardBurialChamber')!;
    expect(chamber.monsterSpawns).toMatchObject([{ kind: 'necromancer', maxAlive: 1 }]);
    const arrival = resolveDoor(chamber, chamber.doors[0]!, bundledModelRegistry())!.arrival;
    expect(distanceToRect(arrival, spawnArea(chamber, chamber.monsterSpawns[0]!)) - EDGE_TOLERANCE).toBeGreaterThan(TELEGRAPHS.wail.radius);
  });

  /** Tacita's trial asks a dreamer to stand at each of its places, so each must be a walk from the town, judged as the server judges a place reached. */
  it("lets a dreamer walk from the Library's door to every place of the Mystic's trial", () => {
    const registry = bundledModelRegistry();
    const outdoors = world.spaces.get(OUTDOOR_SPACE_ID)!;
    const collision = buildSpaceCollision(outdoors, registry);
    const grid = { collision, rasters: outdoors.sectors.map((sector) => rasterizeWalkable(walkRasterInputs(collision, sector))) };
    const square = byName.get('EdariaSquare')!;
    const from = resolveDoor(
      square,
      square.doors.find((door) => door.id === 'to-edarialibrary')!,
      registry,
    )!.arrival;
    for (const objective of quest('mystic-trial').objectives) {
      if (objective.kind !== 'reach' || objective.place === undefined) throw new Error('the Mystic trial is no longer a round of places');
      const path = findPath(grid, from, sectorPointInSpace(byName.get(objective.sector)!, objective.place), npcBodies(outdoors), new Set());
      const end = path.waypoints.at(-1) ?? from;
      expect(reachedAt(objective, sectorAt(outdoors, end)!, end), objective.sector).toBe(true);
    }
  });

  it('builds with every door live, no collision issue, and a clear starter spawn', () => {
    expect(world.issues).toEqual([]);
    expect(byName.get('EdariaLibrary')?.spawn).toBeDefined();

    const outdoors = world.spaces.get(OUTDOOR_SPACE_ID)!;
    const neighbours = (name: string): string[] => neighbourSectors(outdoors, name).map((sector) => sector.name);
    expect(neighbours('EdariaSquare')).toEqual(['AutumnWood', 'NorthMeadow', 'SouthMeadow', 'WestMeadow']);
    expect(neighbours('NorthMeadow')).toEqual(['EdariaSquare', 'NorthWood']);
    expect(neighbours('NorthWood')).toEqual(['NorthMeadow']);
    for (const land of ['SouthMeadow', 'AutumnWood']) expect(neighbours(land)).toEqual(['EdariaSquare']);
    expect(neighbours('WestMeadow')).toEqual(['EdariaSquare', 'Graveyard']);
    expect(neighbours('Graveyard')).toEqual(['WestMeadow']);
  });
});
