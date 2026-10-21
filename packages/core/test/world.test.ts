import type { Door } from '@somnio/protocol';
import { describe, expect, it } from 'vitest';
import { SOMNIO_CONSTANTS } from '../src/constants.ts';
import { modelToWorld } from '../src/geometry.ts';
import type { MonsterSpawn, Sector, SectorNPC } from '../src/sector.ts';
import { OUTDOOR_SPACE_ID, WorldError, buildWorld, doorContains, neighbourSectors, resolveDoor, sectorAt } from '../src/world.ts';
import { TEST_REGISTRY, interiorSector, outdoorSector } from './support/worldFixture.ts';

const HALL = { id: 'hall-1', modelId: 'hall', x: 10, z: 10, yaw: 270, elevation: 0 };
const TOWN_DOOR: Door = { id: 'to-room', placement: 'hall-1', anchor: 'main', target: { sector: 'Room', door: 'exit' } };
const ROOM_DOOR: Door = { id: 'exit', placement: 'door-1', anchor: 'main', target: { sector: 'Town', door: 'to-room' } };

/** A town with a hall and the room behind its door: one sound pair of doors. */
function town(overrides: Partial<Sector> = {}): Sector {
  return outdoorSector('Town', { x: 0, z: 0 }, { placements: [HALL], doors: [TOWN_DOOR], ...overrides });
}

function room(overrides: Partial<Sector> = {}): Sector {
  return interiorSector('Room', { placements: [{ id: 'door-1', modelId: 'door', x: 5, z: 9.9, yaw: 0, elevation: 0 }], doors: [ROOM_DOOR], ...overrides });
}

function guide(x: number, z: number): SectorNPC {
  return { id: 'guide', name: 'Guide', characterModelId: 'hero', x, z, facing: 0, dialogScript: '' };
}

function doorsOf(sectors: Sector[], name: string): string[] {
  const world = buildWorld(sectors, TEST_REGISTRY);
  const space = world.spaces.get(world.sectorSpace.get(name)!)!;
  return space.sectors.find((sector) => sector.name === name)!.doors.map((door) => door.id);
}

describe('buildWorld', () => {
  it('puts every outdoor sector in one space and each interior in its own', () => {
    const world = buildWorld([town(), outdoorSector('Meadow', { x: 0, z: -20 }), room()], TEST_REGISTRY);
    expect([...world.spaces.keys()]).toEqual([OUTDOOR_SPACE_ID, 'Room']);
    expect(world.spaces.get(OUTDOOR_SPACE_ID)!.sectors.map((sector) => sector.name)).toEqual(['Town', 'Meadow']);
    expect(Object.fromEntries(world.sectorSpace)).toEqual({ Town: OUTDOOR_SPACE_ID, Meadow: OUTDOOR_SPACE_ID, Room: 'Room' });
    expect(world.issues).toEqual([]);
    expect(doorsOf([town(), room()], 'Town')).toEqual(['to-room']);
  });

  it('throws on outdoor sectors that overlap, and accepts ones that touch', () => {
    expect(() => buildWorld([town(), outdoorSector('Meadow', { x: 10, z: 0 }), room()], TEST_REGISTRY)).toThrow(WorldError);
    expect(() => buildWorld([town(), outdoorSector('Meadow', { x: 20, z: 0 }), room()], TEST_REGISTRY)).not.toThrow();
  });

  it('throws on an outdoor sector the camera could see past', () => {
    const narrow = outdoorSector('Strip', { x: 0, z: 0 }, { size: { width: SOMNIO_CONSTANTS.minOutdoorSectorExtent - 0.1, depth: 20 } });
    expect(() => buildWorld([narrow], TEST_REGISTRY)).toThrow(/smaller than 16 metres/);
    expect(() => buildWorld([interiorSector('Closet', { size: { width: 3, depth: 3 } })], TEST_REGISTRY)).not.toThrow();
  });

  it('throws on a sector named like the outdoor space', () => {
    expect(() => buildWorld([interiorSector(OUTDOOR_SPACE_ID)], TEST_REGISTRY)).toThrow(/cannot be named/);
  });

  it('throws on a spawn a body cannot stand on, reading it relative to its sector', () => {
    const box = { id: 'box-1', modelId: 'box', x: 5, z: 5, yaw: 0, elevation: 0 };
    expect(() => buildWorld([interiorSector('Start', { placements: [box], spawn: { x: 5, z: 5, facing: 0 } })], TEST_REGISTRY)).toThrow(
      /spawn of sector Start/,
    );
    expect(() => buildWorld([outdoorSector('Start', { x: 100, z: 0 }, { spawn: { x: 5, z: 5, facing: 0 } })], TEST_REGISTRY)).not.toThrow();
  });

  it('throws on a spawn an NPC stands on, and accepts one in contact with it', () => {
    const start = (npcX: number): Sector => interiorSector('Start', { spawn: { x: 5, z: 5, facing: 0 }, npcs: [guide(npcX, 5)] });
    expect(() => buildWorld([start(5.5)], TEST_REGISTRY)).toThrow(/spawn of sector Start/);
    expect(() => buildWorld([start(5.6)], TEST_REGISTRY)).not.toThrow();
  });

  it('judges a spawn against an NPC where its sector puts it in the space', () => {
    const spawn = { x: 5, z: 5, facing: 0 };
    const east = (overrides: Partial<Sector> = {}): Sector => outdoorSector('East', { x: 20, z: 0 }, { npcs: [guide(5.5, 5)], ...overrides });
    // East's guide stands at (25.5, 5) in the space: on East's spawn at (25, 5), and nowhere near West's at (5, 5).
    expect(() => buildWorld([outdoorSector('West', { x: 0, z: 0 }), east({ spawn })], TEST_REGISTRY)).toThrow(/spawn of sector East/);
    expect(() => buildWorld([outdoorSector('West', { x: 0, z: 0 }, { spawn }), east()], TEST_REGISTRY)).not.toThrow();
  });

  it('reports a door whose target is missing and drops it', () => {
    const sectors = [town()];
    expect(buildWorld(sectors, TEST_REGISTRY).issues).toEqual([
      { sector: 'Town', record: 'door', id: 'to-room', message: 'target door "exit" in Room does not exist' },
    ]);
    expect(doorsOf(sectors, 'Town')).toEqual([]);
  });

  it('reports a door whose target does not point back', () => {
    const sectors = [town(), room({ doors: [{ ...ROOM_DOOR, target: { sector: 'Town', door: 'other' } }] })];
    expect(buildWorld(sectors, TEST_REGISTRY).issues).toEqual([
      { sector: 'Town', record: 'door', id: 'to-room', message: 'target door "exit" in Room does not point back' },
      { sector: 'Room', record: 'door', id: 'exit', message: 'target door "other" in Town does not exist' },
    ]);
  });

  it('reports a door that does not resolve, and its counterpart with it', () => {
    const sectors = [town({ doors: [{ ...TOWN_DOOR, anchor: 'side' }] }), room()];
    expect(buildWorld(sectors, TEST_REGISTRY).issues).toEqual([
      { sector: 'Town', record: 'door', id: 'to-room', message: 'placement "hall-1" has no door anchor "side"' },
      { sector: 'Room', record: 'door', id: 'exit', message: 'target door "to-room" in Town is inert' },
    ]);
    expect(doorsOf(sectors, 'Room')).toEqual([]);
  });

  it('reports a door whose arrival point is blocked, and its counterpart with it', () => {
    const sectors = [town(), room({ blockers: [{ id: 'crate', x: 4.5, z: 8.6, width: 1, depth: 1 }] })];
    expect(buildWorld(sectors, TEST_REGISTRY).issues).toEqual([
      { sector: 'Town', record: 'door', id: 'to-room', message: 'target door "exit" in Room is inert' },
      { sector: 'Room', record: 'door', id: 'exit', message: 'the arrival point (5.00, 9.10) is not clear' },
    ]);
  });

  it('reports a door whose arrival point an NPC stands on, and its counterpart with it', () => {
    const sectors = [town(), room({ npcs: [guide(5.4, 9.1)] })];
    expect(buildWorld(sectors, TEST_REGISTRY).issues).toEqual([
      { sector: 'Town', record: 'door', id: 'to-room', message: 'target door "exit" in Room is inert' },
      { sector: 'Room', record: 'door', id: 'exit', message: 'the arrival point (5.00, 9.10) is not clear' },
    ]);
    expect(doorsOf(sectors, 'Town')).toEqual([]);
  });

  it("reports a door whose arrival point lies within a nightmare's reach of a monster spawn's area once, and keeps it live", () => {
    // The room's door puts an arriving body at (5, 9.1); a nightmare's reach is 0.85 m.
    const spawn = (id: string, depth: number): MonsterSpawn => ({ id, kind: 'ghost', x: 4, z: 7.5, width: 2, depth, maxAlive: 1 });
    const spawned = (...monsterSpawns: MonsterSpawn[]): Sector[] => [town(), room({ monsterSpawns })];
    const inReach = {
      sector: 'Room',
      record: 'door',
      id: 'exit',
      message: 'the arrival point (5.00, 9.10) lies within reach of monster spawn "spawn-1" in Room',
    };
    expect(buildWorld(spawned(spawn('spawn-1', 1)), TEST_REGISTRY).issues).toEqual([inReach]);
    expect(doorsOf(spawned(spawn('spawn-1', 1)), 'Room')).toEqual(['exit']);
    expect(buildWorld(spawned(spawn('spawn-1', 1), spawn('spawn-2', 1)), TEST_REGISTRY).issues).toEqual([inReach]);
    expect(buildWorld(spawned(spawn('spawn-1', 0.7)), TEST_REGISTRY).issues).toEqual([]);
    // A spawn in another sector of the space reaches the door too, measured in the space's coordinates:
    // the hall's door puts an arriving body 0.28 m north of Field.
    const field = outdoorSector('Field', { x: 100, z: -30 }, { monsterSpawns: [{ ...spawn('spawn-1', 1), x: 8.5, z: 0, width: 1 }] });
    const hallTown = town({ origin: { x: 100, z: -50 }, placements: [{ ...HALL, z: 17.5 }] });
    expect(buildWorld([hallTown, field, room()], TEST_REGISTRY).issues).toEqual([
      { sector: 'Town', record: 'door', id: 'to-room', message: 'the arrival point (109.10, -30.28) lies within reach of monster spawn "spawn-1" in Field' },
    ]);
    // A nightmare's centre may stand EDGE_TOLERANCE past its area on either axis, so the reach is
    // measured from the widened area: along a side and diagonally off a corner, just within it and just beyond.
    const issueCount = (monsterSpawn: MonsterSpawn): number => buildWorld(spawned(monsterSpawn), TEST_REGISTRY).issues.length;
    const southEdge = (z: number): MonsterSpawn => ({ ...spawn('spawn-1', z - 7.5), x: 4, z: 7.5 });
    expect([issueCount(southEdge(9.1 - 0.8505)), issueCount(southEdge(9.1 - 0.8515))]).toEqual([1, 0]);
    const cornerOff = (away: number): MonsterSpawn => ({ ...spawn('spawn-1', 9.1 - away - 6), x: 2, z: 6, width: 5 - away - 2 });
    expect([issueCount(cornerOff(0.6018)), issueCount(cornerOff(0.6023))]).toEqual([1, 0]);
    // An inert door is reported for what makes it inert, and for nothing more.
    expect(buildWorld([room({ monsterSpawns: [spawn('spawn-1', 1)] })], TEST_REGISTRY).issues).toEqual([
      { sector: 'Room', record: 'door', id: 'exit', message: 'target door "to-room" in Town does not exist' },
    ]);
  });

  it('carries the collision issues of every space', () => {
    const sectors = [town(), room({ placements: [...room().placements, { id: 'mystery-1', modelId: 'mystery', x: 2, z: 2, yaw: 0, elevation: 0 }] })];
    expect(buildWorld(sectors, TEST_REGISTRY).issues).toEqual([
      { sector: 'Room', record: 'placement', id: 'mystery-1', message: expect.stringContaining('not in the registry') },
    ]);
  });
});

/**
 * A client blends a sector's ground only with the sectors touching it, so two that do not touch
 * must stand clear of each other's blend: past the 4 m a background paints beyond its rect, plus the
 * gutter its raster reaches beyond.
 */
describe('the spacing of outdoor sectors', () => {
  it('reports two sectors standing 1 m apart under each of them, and still loads the world', () => {
    const west = outdoorSector('West', { x: 0, z: 0 });
    const east = outdoorSector('East', { x: 21, z: 0 });
    const world = buildWorld([west, east], TEST_REGISTRY);
    expect(world.issues).toEqual([
      { sector: 'West', record: 'sector', id: 'East', message: expect.stringContaining('0.64 m from East without touching it') },
      { sector: 'East', record: 'sector', id: 'West', message: expect.stringContaining('from West') },
    ]);
    expect(world.spaces.get(OUTDOOR_SPACE_ID)?.sectors).toHaveLength(2);
  });

  /** A flat 4.5 m rule would pass this layout: A's 2.56 m gutter at 0.64 m texels reaches within 1.95 m of C, and C's within 1.92 m of A, where B blends C in and A does not. */
  it('counts the gutter of a coarse raster', () => {
    const size = { width: 512, depth: 512 };
    const a = outdoorSector('A', { x: 0, z: 0 }, { size });
    const b = outdoorSector('B', { x: 512, z: 128 }, { size });
    const c = outdoorSector('C', { x: 0, z: 516.51 }, { size });
    const issues = buildWorld([a, b, c], TEST_REGISTRY).issues;
    expect(issues.map((issue) => `${issue.sector}/${issue.id}`)).toEqual(['A/C', 'C/A']);
    expect(issues[0]!.message).toContain('1.92 m');
  });

  it('reports nothing for sectors that touch, or that stand far enough apart', () => {
    const issues = buildWorld(
      [outdoorSector('A', { x: 0, z: 0 }), outdoorSector('B', { x: 20, z: 0 }), outdoorSector('C', { x: 44.33, z: 0 })],
      TEST_REGISTRY,
    ).issues;
    expect(issues).toEqual([]);
  });
});

describe('adjacency', () => {
  // The committed outdoor layout, whose origins and sizes are decimal metres that do not sum exactly, plus a sector touching only at a corner.
  const town = outdoorSector('Town', { x: 0, z: 0 }, { size: { width: 40.96, depth: 40.96 } });
  const meadow = outdoorSector('Meadow', { x: 5.12, z: -30.72 }, { size: { width: 30.72, depth: 30.72 } });
  const forest = outdoorSector('Forest', { x: 5.12, z: -61.44 }, { size: { width: 30.72, depth: 30.72 } });
  const corner = outdoorSector('Corner', { x: 40.96, z: -20 });
  const space = { id: OUTDOOR_SPACE_ID, sectors: [town, meadow, forest, corner] };

  it('finds the sectors sharing an edge or a corner, and no others', () => {
    expect(neighbourSectors(space, 'Town')).toEqual([meadow, corner]);
    expect(neighbourSectors(space, 'Meadow')).toEqual([town, forest]);
    expect(neighbourSectors(space, 'Forest')).toEqual([meadow]);
    expect(neighbourSectors(space, 'Nowhere')).toEqual([]);
  });

  it('finds the sector under a point', () => {
    expect(sectorAt(space, { x: 10, z: 5 })).toBe(town);
    expect(sectorAt(space, { x: 10, z: -5 })).toBe(meadow);
    expect(sectorAt(space, { x: 10, z: -35 })).toBe(forest);
    expect(sectorAt(space, { x: 0, z: -5 })).toBeUndefined();
  });
});

describe('resolveDoor', () => {
  it('puts the arrival point 0.8 m out of the doorway, facing away from it, in space coordinates', () => {
    const resolved = resolveDoor(town({ origin: { x: 100, z: -50 } }), TOWN_DOOR, TEST_REGISTRY)!;
    // The hall's door side points south at yaw 270; its anchor is 1.42 m out and 0.9 m along the front.
    expect(resolved.doorway.x).toBeCloseTo(100 + 10 - 0.9, 9);
    expect(resolved.doorway.z).toBeCloseTo(-50 + 10 + 1.42, 9);
    expect(resolved.arrival.x).toBeCloseTo(100 + 10 - 0.9, 9);
    expect(resolved.arrival.z).toBeCloseTo(-50 + 10 + 1.42 + 0.8, 9);
    expect(resolved.facing).toBe(0);
    expect(resolved.transform).toEqual({ x: 110, z: -40, yaw: 270 });
  });

  it('lays the trigger in front of the anchor: its width across, the trigger depth out', () => {
    const outward = resolveDoor(town(), TOWN_DOOR, TEST_REGISTRY)!.trigger;
    expect(outward.x).toBe(1.42);
    expect(outward.z).toBeCloseTo(0.14, 9);
    expect(outward.width).toBe(SOMNIO_CONSTANTS.doorTriggerDepth);
    expect(outward.depth).toBe(1.52);

    const inward = resolveDoor(room(), ROOM_DOOR, TEST_REGISTRY)!;
    expect(inward.trigger).toEqual({ x: -0.77, z: -SOMNIO_CONSTANTS.doorTriggerDepth, width: 1.54, depth: SOMNIO_CONSTANTS.doorTriggerDepth });
    expect(inward.arrival.x).toBeCloseTo(5, 9);
    expect(inward.arrival.z).toBeCloseTo(9.1, 9);
    expect(inward.facing).toBe(180);
  });

  it('is undefined for a missing placement, an unmapped model, and a missing anchor', () => {
    expect(resolveDoor(town({ placements: [] }), TOWN_DOOR, TEST_REGISTRY)).toBeUndefined();
    expect(resolveDoor(town({ placements: [{ ...HALL, modelId: 'mystery' }] }), TOWN_DOOR, TEST_REGISTRY)).toBeUndefined();
    expect(resolveDoor(town(), { ...TOWN_DOOR, anchor: 'side' }, TEST_REGISTRY)).toBeUndefined();
  });
});

describe('doorContains', () => {
  it.each([270, 30])('follows the placement at yaw %i', (yaw) => {
    const hall = { ...HALL, yaw };
    const resolved = resolveDoor(town({ placements: [hall] }), TOWN_DOOR, TEST_REGISTRY)!;
    const inside = modelToWorld(hall, { x: 1.8, z: 0.9 });
    const beyond = modelToWorld(hall, { x: 2.1, z: 0.9 });
    expect(doorContains(resolved, inside, 0)).toBe(true);
    expect(doorContains(resolved, beyond, 0)).toBe(false);
    expect(doorContains(resolved, beyond, SOMNIO_CONSTANTS.doorUseSlack)).toBe(true);
    // The arrival point lies outside the trigger, so an arriving body does not turn straight back.
    expect(doorContains(resolved, resolved.arrival, 0)).toBe(false);
  });
});
