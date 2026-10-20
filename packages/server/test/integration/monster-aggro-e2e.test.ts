import { describe, expect, it } from 'vitest';
import {
  OUTDOOR_SPACE_ID,
  SOMNIO_CONSTANTS,
  buildSpaceCollision,
  distance,
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
import { RESPAWN_MS } from '../support/combat.ts';
import { collectMessages, entities, entityMoves } from '../support/frames.ts';
import { attachPlayer, makeClockedSpace } from '../support/sectorFactory.ts';
import { fixtureWorld } from './support/harness.ts';

const world = fixtureWorld();
const collision = buildSpaceCollision(world.spaces.get(OUTDOOR_SPACE_ID)!, world.registry);
const GHOST = monsterKind('ghost');
/** In the North Meadow, which sees the North Wood from well outside any aggro radius. */
const SCOUT_AT: Point = { x: 20.48, z: -15 };
const NORTH_WOOD = world.spaces.get(OUTDOOR_SPACE_ID)!.sectors.find((sector) => sector.name === 'NorthWood')!;
/** The North Wood spawn's area, its Ghosts' home ground: they chase only dreamers standing in it. */
const GROUND = spawnArea(NORTH_WOOD, NORTH_WOOD.monsterSpawns[0]!);

/** The committed outdoor space with the North Wood's first Ghost already spawned, and where it stands. */
async function northWood() {
  const { clock, space } = makeClockedSpace(world, OUTDOOR_SPACE_ID, { random: seededRandom(11) });
  clock.ms = RESPAWN_MS;
  const scout = attachPlayer(space, SCOUT_AT, 'scout');
  space.step(0);
  space.detach(scout.entityId, true);
  const [monster] = entities(await collectMessages(scout.outbox)).filter((entity) => entity.kind === 'monster');
  if (monster === undefined) throw new Error('no Ghost spawned in the North Wood');
  return { space, monster: { x: monster.x, z: monster.z } };
}

/** A point of its ground `away` metres from the monster that a player can stand on with a clear line between the two, searched from compass step `first`. */
function clearLineFrom(space: SpaceActor, monster: Point, away: number, first = 0): Point {
  for (let step = first; step < first + 16; step += 1) {
    const angle = (step * Math.PI) / 8;
    const candidate = { x: monster.x + away * Math.sin(angle), z: monster.z + away * Math.cos(angle) };
    if (rectContains(GROUND, candidate) && space.canStand(candidate) && isLegalMove(collision, monster, candidate, GHOST.radius, [])) return candidate;
  }
  throw new Error('the Ghost is walled in');
}

/** Seven 50 ms steps, each flushed, as the simulation service would run them, and everything the outbox's dreamer was sent. */
async function sevenSteps(space: SpaceActor, outbox: ConnectionOutbox) {
  for (let pass = 0; pass < 7; pass += 1) {
    space.step(0.05);
    space.flushMoves();
  }
  return collectMessages(outbox);
}

async function chase(space: SpaceActor, outbox: ConnectionOutbox) {
  return entityMoves(await sevenSteps(space, outbox));
}

describe('monster aggro end to end', () => {
  it('idles when no player is within the aggro radius', async () => {
    const { space } = await northWood();
    const messages = await sevenSteps(space, attachPlayer(space, SCOUT_AT, 'far').outbox);
    expect(entities(messages).filter((entity) => entity.kind === 'monster')).toHaveLength(1);
    expect(entityMoves(messages)).toEqual([]);
  });

  it('chases a player who enters the aggro radius', async () => {
    const { space, monster } = await northWood();
    const player = clearLineFrom(space, monster, 3);
    const moves = await chase(space, attachPlayer(space, player, 'near').outbox);
    expect(moves).toHaveLength(7);
    const distances = moves.map((move) => distance(move, player));
    for (let index = 1; index < distances.length; index += 1) {
      expect(distances[index]).toBeLessThan(distances[index - 1]!);
    }
    expect(distances.at(-1)!).toBeCloseTo(3 - 7 * 0.05 * GHOST.metresPerSecond, 9);
  });

  it('targets the nearest of multiple players in the aggro radius', async () => {
    const { space, monster } = await northWood();
    const near = clearLineFrom(space, monster, 2);
    const { outbox } = attachPlayer(space, clearLineFrom(space, monster, 3.5, 8), 'far');
    attachPlayer(space, near, 'near');
    const [first] = await chase(space, outbox);
    expect(first?.facing).toBe(headingFromVector(near.x - monster.x, near.z - monster.z));
  });

  it('stops short of the player it caught', async () => {
    const { space, monster } = await northWood();
    const player = clearLineFrom(space, monster, 0.8);
    const moves = await chase(space, attachPlayer(space, player, 'caught').outbox);
    const contact = GHOST.radius + SOMNIO_CONSTANTS.playerRadius;
    for (const move of moves) expect(distance(move, player)).toBeGreaterThanOrEqual(contact);
  });
});
