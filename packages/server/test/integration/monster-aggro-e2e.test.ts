import { describe, expect, it } from 'vitest';
import {
  OUTDOOR_SPACE_ID,
  SOMNIO_CONSTANTS,
  buildSpaceCollision,
  distance,
  gaitMetresPerSecond,
  headingFromVector,
  isLegalMove,
  monsterKind,
  rectContains,
  spawnArea,
} from '@somnio/core';
import type { Point } from '@somnio/core';
import type { ConnectionOutbox } from '../../src/connection/outbox.ts';
import { seededRandom } from '../../src/world/random.ts';
import type { SpaceActor } from '../../src/world/spaceActor.ts';
import { collectMessages, entities, entityMoves } from '../support/frames.ts';
import { attachPlayer, makeClockedSpace } from '../support/sectorFactory.ts';
import { fixtureWorld } from './support/harness.ts';

const world = fixtureWorld();
const collision = buildSpaceCollision(world.spaces.get(OUTDOOR_SPACE_ID)!, world.registry);
const WOLF = monsterKind('wolf');
/** In the North Meadow, which sees the North Wood from well outside any aggro radius. */
const SCOUT_AT: Point = { x: 20.48, z: -15 };
const NORTH_WOOD = world.spaces.get(OUTDOOR_SPACE_ID)!.sectors.find((sector) => sector.name === 'NorthWood')!;
/** The North Wood's Wolf spawn's area, where its Wolves spawn, wander, and walk back to after a chase, which it does not bound. */
const GROUND = spawnArea(
  NORTH_WOOD,
  NORTH_WOOD.monsterSpawns.find((spawn) => spawn.kind === 'wolf')!,
);

/**
 * The committed outdoor space at the Wolves' first fill, with the North Wood's first Wolf spawned, and
 * where it stands. Every other spawn the North Meadow sees fills later, so the Wolf stands alone there.
 */
async function northWood() {
  const { clock, space } = makeClockedSpace(world, OUTDOOR_SPACE_ID, { random: seededRandom(11), wanderRandom: seededRandom(11) });
  clock.ms = WOLF.respawnSeconds * 1000;
  const scout = attachPlayer(space, SCOUT_AT, 'scout');
  space.step(0);
  space.handOver(scout.entityId, true);
  const monster = entities(await collectMessages(scout.outbox)).find(
    (entity) => entity.kind === 'monster' && entity.name === WOLF.name && rectContains(GROUND, entity),
  );
  if (monster === undefined) throw new Error('no Wolf spawned in the North Wood');
  return { clock, space, monster: { id: monster.id, x: monster.x, z: monster.z } };
}

/** The point `away` metres from `from` at compass step `step` of 16. */
function toward(from: Point, step: number, away: number): Point {
  const angle = (step * Math.PI) / 8;
  return { x: from.x + away * Math.sin(angle), z: from.z + away * Math.cos(angle) };
}

/** Whether the Wolf could walk straight from `from` to `to`, and a player stand at `to`. */
function clearLine(space: SpaceActor, from: Point, to: Point): boolean {
  return space.canStand(to) && isLegalMove(collision, from, to, WOLF.radius, []);
}

/** A point `away` metres from the monster that a player can stand on with a clear line between the two, searched from compass step `first`. */
function clearLineFrom(space: SpaceActor, monster: Point, away: number, first = 0): Point {
  for (let step = first; step < first + 16; step += 1) {
    const candidate = toward(monster, step, away);
    if (clearLine(space, monster, candidate)) return candidate;
  }
  throw new Error('the Wolf is walled in');
}

/** The first compass step along which a player can lead the monster straight out past its leash, every point of the way clear. */
function leashLine(space: SpaceActor, monster: Point): number {
  for (let step = 0; step < 16; step += 1) {
    const far = toward(monster, step, WOLF.leashMetres + 2);
    if (clearLine(space, monster, far) && rectContains(GROUND, far) === false) return step;
  }
  throw new Error('no clear line out of the North Wood');
}

/** Seven 50 ms steps, each flushed, as the simulation service would run them, and everything the outbox's dreamer was sent. */
async function sevenSteps(space: SpaceActor, outbox: ConnectionOutbox) {
  for (let pass = 0; pass < 7; pass += 1) {
    space.step(0.05);
    space.flushMoves();
  }
  return collectMessages(outbox);
}

/** The moves of the monster `id` over `sevenSteps`. */
async function chase(space: SpaceActor, outbox: ConnectionOutbox, id: string) {
  return entityMoves(await sevenSteps(space, outbox)).filter((move) => move.id === id);
}

describe('monster aggro end to end', () => {
  /** Seven steps end long before its first wander, 6 s at the soonest after it stands. */
  it('idles when no player is within the aggro radius', async () => {
    const { space } = await northWood();
    const messages = await sevenSteps(space, attachPlayer(space, SCOUT_AT, 'far').outbox);
    expect(entities(messages).filter((entity) => entity.kind === 'monster')).toHaveLength(1);
    expect(entityMoves(messages)).toEqual([]);
  });

  it('chases a player who enters the aggro radius', async () => {
    const { space, monster } = await northWood();
    const player = clearLineFrom(space, monster, 3);
    const moves = await chase(space, attachPlayer(space, player, 'near').outbox, monster.id);
    expect(moves).toHaveLength(7);
    const distances = moves.map((move) => distance(move, player));
    for (let index = 1; index < distances.length; index += 1) {
      expect(distances[index]).toBeLessThan(distances[index - 1]!);
    }
    expect(distances.at(-1)!).toBeCloseTo(3 - 7 * 0.05 * WOLF.chaseMetresPerSecond, 9);
  });

  it('targets the nearest of multiple players in the aggro radius', async () => {
    const { space, monster } = await northWood();
    const near = clearLineFrom(space, monster, 2);
    const { outbox } = attachPlayer(space, clearLineFrom(space, monster, 3.5, 8), 'far');
    attachPlayer(space, near, 'near');
    const [first] = await chase(space, outbox, monster.id);
    expect(first?.facing).toBe(headingFromVector(near.x - monster.x, near.z - monster.z));
  });

  it('stops short of the player it caught', async () => {
    const { space, monster } = await northWood();
    const player = clearLineFrom(space, monster, 0.8);
    const moves = await chase(space, attachPlayer(space, player, 'caught').outbox, monster.id);
    const contact = WOLF.radius + SOMNIO_CONSTANTS.playerRadius;
    for (const move of moves) expect(distance(move, player)).toBeGreaterThanOrEqual(contact);
  });

  it('chases a player it noticed out of its area, gives its fight up past its leash, and walks back to where it stood', async () => {
    const { clock, space, monster } = await northWood();
    const step = leashLine(space, monster);
    const leader = attachPlayer(space, toward(monster, step, 3), 'leader');
    const tick = (): void => {
      clock.ms += 50;
      space.step(0.05);
      space.flushMoves();
    };
    // She jogs straight out, slower than it runs, so it closes on her and follows at her pace.
    const pace = 0.05 * gaitMetresPerSecond('jog');
    expect(pace).toBeLessThan(0.05 * WOLF.chaseMetresPerSecond);
    for (let away = 3 + pace; away <= WOLF.leashMetres + 2; away += pace) {
      space.handleMove({ ...toward(monster, step, away), facing: step * 22.5, gait: 'jog' }, leader.entityId);
      tick();
    }
    // Home lies no farther than its leash and a stride, which it runs back over, with a second to spare.
    const homeTicks = Math.ceil((WOLF.leashMetres + 0.05 * WOLF.chaseMetresPerSecond) / (0.05 * WOLF.chaseMetresPerSecond)) + 20;
    for (let pass = 0; pass < 10 + homeTicks; pass += 1) tick();
    const moves = entityMoves(await collectMessages(leader.outbox)).filter((move) => move.id === monster.id);
    expect(moves.some((move) => !rectContains(GROUND, move))).toBe(true);
    const aways = moves.map((move) => distance(move, monster));
    const farthest = Math.max(...aways);
    expect(farthest).toBeGreaterThan(WOLF.leashMetres);
    expect(farthest).toBeLessThanOrEqual(WOLF.leashMetres + 0.05 * WOLF.chaseMetresPerSecond);
    expect(aways.slice(aways.indexOf(farthest)).some((away) => away < 0.01)).toBe(true);
  });
});
