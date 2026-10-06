import { NO_LUCIDITY, OUTDOOR_SPACE_ID, fullPools, monsterKind } from '@somnio/core';
import type { Character, InventoryRow, Lucidity, Point, Sector, TeachingId } from '@somnio/core';
import type { Energy, SomnioMessage } from '@somnio/protocol';
import { ranks } from '../../../core/test/support/ranks.ts';
import type { SpaceActor } from '../../src/world/spaceActor.ts';
import { makeClockedSpace, makeMonsterSpawn, makeSector, makeWorld } from './sectorFactory.ts';

const GHOST_AT: Point = { x: 10, z: 10 };
/** In reach of the nightmare at `GHOST_AT`, and south of it. */
export const BESIDE_GHOST: Point = { x: 10, z: 10.7 };
export const GHOST = 'monster:1';
export const RESPAWN_MS = monsterKind('gespenst').respawnSeconds * 1000;
const STEP_SECONDS = 0.05;

export const CUDGEL_IN_HAND: InventoryRow = { slot: 1, itemId: 'cudgel', quantity: 1, equippedHand: 'right' };
export const MONDSTEIN_IN_HAND: InventoryRow = { slot: 2, itemId: 'mondstein', quantity: 1, equippedHand: 'right' };

export function energy(overrides: Partial<Energy> = {}): Energy {
  return { ...fullPools([]), ...overrides };
}

export function lucidity(role: Lucidity['role'], held: Partial<Record<TeachingId, number>> = {}, overrides: Partial<Lucidity> = {}): Lucidity {
  return { ...NO_LUCIDITY, role, ranks: ranks(held), ...overrides };
}

/** A Kämpfer whose every landed cudgel swing takes 23 of a Gespenst's 60 health, so three drive it off. */
export const STRIKER: Partial<Character> = { lucidity: lucidity('kaempfer', { strike: 5 }) };

/**
 * One 20 x 20 m sector on a clock the test advances, where every roll lands while `dice.hit` is
 * set and misses otherwise. With `ghost`, a Gespenst already stands at `GHOST_AT`.
 */
export function arena(overrides: Partial<Sector> = {}, options: { ghost?: boolean; sectors?: Sector[] } = {}) {
  const dice = { hit: true };
  const ghost = options.ghost ?? true;
  const sector = makeSector('TestSector', { ...(ghost ? { monsterSpawns: [makeMonsterSpawn(GHOST_AT)] } : {}), ...overrides });
  const { clock, space } = makeClockedSpace(makeWorld([sector, ...(options.sectors ?? [])]), OUTDOOR_SPACE_ID, {
    random: { nextUInt32: () => (dice.hit ? 0 : 0xffff_ffff) },
  });
  if (ghost) {
    clock.ms = RESPAWN_MS;
    space.step(0);
  }
  /** Runs the simulation for `count` steps of 50 ms, calling `each` before every one. */
  const steps = (count: number, each: () => void = () => {}): void => {
    for (let index = 0; index < count; index += 1) {
      clock.ms += STEP_SECONDS * 1000;
      each();
      space.step(STEP_SECONDS);
    }
  };
  return { clock, space, dice, steps };
}

export function characterOf(space: SpaceActor, entityId: string): Character {
  return space.snapshotForPlayer(entityId)!.character;
}

export function energyOf(space: SpaceActor, entityId: string): Energy {
  return characterOf(space, entityId).energy;
}

type PayloadOf<T extends SomnioMessage['tag']> = Extract<SomnioMessage, { tag: T }>['payload'];

/** The payload of every frame carrying `tag`, in order. */
export function payloads<T extends SomnioMessage['tag']>(messages: readonly SomnioMessage[], tag: T): PayloadOf<T>[] {
  return messages.flatMap((message) => (message.tag === tag ? [message.payload as PayloadOf<T>] : []));
}
