import type { Door } from '@somnio/protocol';
import { OUTDOOR_SPACE_ID, headingFromCardinal } from '@somnio/core';
import type { Character, MonsterSpawn, Point, Sector, SectorNPC } from '@somnio/core';
import { STARTER_SECTOR } from '@somnio/data';
import { TEST_REGISTRY, interiorSector, outdoorSector } from '../../../core/test/support/worldFixture.ts';
import { ConnectionOutbox } from '../../src/connection/outbox.ts';
import { loadWorld } from '../../src/sectors/sectorCache.ts';
import type { LoadedWorld } from '../../src/sectors/sectorCache.ts';
import { SpaceActor } from '../../src/world/spaceActor.ts';
import type { SpaceActorOptions } from '../../src/world/spaceActor.ts';
import { testLogger } from './logger.ts';

/** A 20 x 20 m outdoor sector at the space's origin unless overridden. */
export function makeSector(name = 'TestSector', overrides: Partial<Sector> = {}): Sector {
  return outdoorSector(name, { x: 0, z: 0 }, overrides);
}

/** Three 20 x 20 m outdoor sectors in a line running east: `West` at x 0, `Middle` at x 20, `East` at x 40. */
export function makeSectorLine(overrides: { west?: Partial<Sector>; middle?: Partial<Sector>; east?: Partial<Sector> } = {}): Sector[] {
  return [
    outdoorSector('West', { x: 0, z: 0 }, overrides.west),
    outdoorSector('Middle', { x: 20, z: 0 }, overrides.middle),
    outdoorSector('East', { x: 40, z: 0 }, overrides.east),
  ];
}

/**
 * The served world over `sectors` and the test registry. Every world needs the starter sector, so
 * one is added (a 10 x 10 m interior with its spawn in the middle) unless `sectors` brings its own.
 */
export function makeWorld(sectors: readonly Sector[] = []): LoadedWorld {
  const all = sectors.some((sector) => sector.name === STARTER_SECTOR)
    ? sectors
    : [...sectors, interiorSector(STARTER_SECTOR, { spawn: { x: 5, z: 5, facing: headingFromCardinal('south') } })];
  return loadWorld(new Map(all.map((sector) => [sector.name, sector])), TEST_REGISTRY);
}

/**
 * A door on a `door` placement of its own at `at`, opening north: its trigger is the 0.58 m of
 * ground north of `at` and it puts an arriving body 0.8 m north of `at`. Spread into a sector's
 * overrides; a door works only when its target points back.
 */
export function makeDoor(id: string, at: Point, target: Door['target']): Pick<Sector, 'placements' | 'doors'> {
  return {
    placements: [{ id: `${id}-frame`, modelId: 'door', ...at, yaw: 0, elevation: 0 }],
    doors: [{ id, placement: `${id}-frame`, anchor: 'main', target }],
  };
}

export function makeNPC(id: string, at: Point, dialogScript: string): SectorNPC {
  return { id, name: 'test-npc', characterModelId: 'hero', ...at, facing: headingFromCardinal('south'), dialogScript };
}

/** A spawn whose area is the single point `at`, so the spawn position is independent of the RNG; `size` widens it for placement sampling. */
export function makeMonsterSpawn(at: Point, size = 0, maxAlive = 1): MonsterSpawn {
  return { id: 'spawn-1', kind: 'gespenst', ...at, width: size, depth: size, maxAlive };
}

export function makeCharacter(position: Point, name = 'tester', space: string = OUTDOOR_SPACE_ID): Character {
  return {
    id: crypto.randomUUID(),
    name,
    people: 'wachen',
    space,
    position,
    facing: headingFromCardinal('south'),
    energy: {
      healthCurrent: 100,
      healthMax: 100,
      balanceCurrent: 100,
      balanceMax: 100,
      spiritCurrent: 100,
      spiritMax: 100,
    },
    lastSeen: new Date(),
  };
}

/** One space of the world on a clock the test advances. */
export function makeClockedSpace(world: LoadedWorld, spaceId: string = OUTDOOR_SPACE_ID, options: Partial<SpaceActorOptions> = {}) {
  const clock = { ms: 0 };
  const space = new SpaceActor(world, spaceId, { logger: testLogger(), now: () => clock.ms, ...options });
  return { clock, space };
}

export interface AttachPlayerOptions {
  /** The space the character's row names, for a test that attaches to another space than the outdoor one. */
  spaceId?: string;
  outbox?: ConnectionOutbox;
  worldSeconds?: number;
}

/** Attaches a new character at `at`, on an outbox of its own unless one is given. */
export function attachPlayer(space: SpaceActor, at: Point, name = 'tester', options: AttachPlayerOptions = {}) {
  const outbox = options.outbox ?? new ConnectionOutbox(4096);
  const character = makeCharacter(at, name, options.spaceId);
  space.attach(character, [], outbox, options.worldSeconds ?? 0);
  return { outbox, character, entityId: character.id };
}
