import { NO_LUCIDITY, OUTDOOR_SPACE_ID, fullPools, headingFromVector, monsterKind } from '@somnio/core';
import type { Character, InventoryRow, Lucidity, Point, Sector, TeachingId } from '@somnio/core';
import type { Energy, SomnioMessage } from '@somnio/protocol';
import { ranks } from '../../../core/test/support/ranks.ts';
import type { SpaceActor } from '../../src/world/spaceActor.ts';
import { landsAtCentre, makeClockedSpace, makeMonsterGround, makeMonsterSpawn, makeSector, makeWorld } from './sectorFactory.ts';

export const GHOST_AT: Point = { x: 10, z: 10 };
/** In reach of the nightmare at `GHOST_AT`, and south of it. */
export const BESIDE_GHOST: Point = { x: 10, z: 10.7 };
export const GHOST = 'monster:1';
export const RESPAWN_MS = monsterKind('ghost').respawnSeconds * 1000;
const STEP_SECONDS = 0.05;

export const PURSE: InventoryRow = { slot: 0, itemId: 'purse', quantity: 100, equippedHand: undefined };
export const CUDGEL_IN_HAND: InventoryRow = { slot: 1, itemId: 'cudgel', quantity: 1, equippedHand: 'right' };
export const MOONSTONE_IN_HAND: InventoryRow = { slot: 2, itemId: 'moonstone', quantity: 1, equippedHand: 'right' };

export function energy(overrides: Partial<Energy> = {}): Energy {
  return { ...fullPools(NO_LUCIDITY), ...overrides };
}

/** A dreamer at `healthCurrent` and every other pool full. */
export function wounded(healthCurrent: number): Partial<Character> {
  return { energy: energy({ healthCurrent }) };
}

export function lucidity(role: Lucidity['role'], held: Partial<Record<TeachingId, number>> = {}, overrides: Partial<Lucidity> = {}): Lucidity {
  return { ...NO_LUCIDITY, role, ranks: ranks(held), ...overrides };
}

/** A Fighter whose every landed cudgel swing takes 23 of a Ghost's 60 health, so three drive it off. */
export const STRIKER: Partial<Character> = { lucidity: lucidity('fighter', { strike: 5 }) };

/**
 * One 20 x 20 m sector on a clock the test advances, where every roll lands while `dice.hit` is
 * set and misses otherwise. With `ghost`, a Ghost already stands at `GHOST_AT`. With `ground`, it
 * keeps to a home ground reaching that many metres each way, where it can chase.
 */
export function arena(overrides: Partial<Sector> = {}, options: { ghost?: boolean; ground?: number; sectors?: Sector[] } = {}) {
  const dice = { hit: true };
  const ghost = options.ghost ?? true;
  const spawn = options.ground === undefined ? makeMonsterSpawn(GHOST_AT) : makeMonsterGround(GHOST_AT, options.ground);
  const sector = makeSector('TestSector', { ...(ghost ? { monsterSpawns: [spawn] } : {}), ...overrides });
  const lands = landsAtCentre(options.ground ?? 0);
  const { clock, space } = makeClockedSpace(makeWorld([sector, ...(options.sectors ?? [])]), OUTDOOR_SPACE_ID, {
    random: { nextUInt32: () => (dice.hit ? lands.nextUInt32() : 0xffff_ffff) },
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

/** Turns the dreamer on the spot toward `point`, as their client reports a turn. */
export function face(space: SpaceActor, entityId: string, point: Point): void {
  const at = characterOf(space, entityId).position;
  space.handleMove({ x: at.x, z: at.z, facing: headingFromVector(point.x - at.x, point.z - at.z), gait: 'walk' }, entityId);
}

/** Turns the dreamer toward the Ghost, targets it, and switches Attack on, as their client would. */
export function attackGhost(space: SpaceActor, entityId: string): void {
  face(space, entityId, GHOST_AT);
  engage(space, GHOST, entityId);
}

/** Targets the entity and switches slot 1 on, as a press on its body and then on slot 1 does. */
export function engage(space: SpaceActor, targetId: string, entityId: string): void {
  space.handleTarget(targetId, entityId);
  space.handleEngage(true, entityId);
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
