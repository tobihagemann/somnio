import { expect, it } from 'vitest';
import { COMBAT, SOMNIO_CONSTANTS, monsterKind } from '@somnio/core';
import { seededRandom } from '../../src/world/random.ts';
import { CUDGEL_IN_HAND, RESPAWN_MS, STRIKER, payloads } from '../support/combat.ts';
import { collectMessages, entities } from '../support/frames.ts';
import { attachPlayer, makeClockedSpace } from '../support/sectorFactory.ts';
import { fixtureWorld, standableNear } from './support/harness.ts';

const GESPENST = monsterKind('gespenst');

/**
 * The committed Arena on a clock and a seeded roll: a booted server has neither seam, and its
 * first Gespenst spawns a minute after boot.
 */
it('a Gespenst of the committed Arena is fought to its fade, and its spawn then keeps a full count alive again', async () => {
  const { clock, space } = makeClockedSpace(fixtureWorld(), 'EdariaArena', { random: seededRandom(3) });
  clock.ms = RESPAWN_MS;
  space.step(0);
  const scout = attachPlayer(space, { x: 5.12, z: 8 }, 'scout', { spaceId: 'EdariaArena' });
  space.detach(scout.entityId, true);
  const [ghost] = entities(await collectMessages(scout.outbox)).filter((entity) => entity.kind === 'monster');
  if (ghost === undefined) throw new Error('no Gespenst spawned in the Arena');

  const reach = SOMNIO_CONSTANTS.playerRadius + GESPENST.radius + COMBAT.reachSlack;
  const fighter = attachPlayer(space, standableNear(space, ghost, reach), 'fighter', {
    spaceId: 'EdariaArena',
    character: STRIKER,
    inventory: [CUDGEL_IN_HAND],
  });
  let swings = 0;
  for (; swings < 20 && space.snapshotForPlayer(fighter.entityId)!.inventory.length === 1; swings += 1) {
    space.handleSwing(ghost.id, fighter.entityId);
    for (let step = 0; step < 20; step += 1) {
      clock.ms += 50;
      space.step(0.05);
    }
  }
  // Its bounty is what put a purse beside the cudgel.
  expect(space.snapshotForPlayer(fighter.entityId)!.inventory).toContainEqual({ slot: 0, itemId: 'purse', quantity: GESPENST.bounty, equippedHand: undefined });
  expect(space.isFallen(fighter.entityId)).toBe(false);
  space.detach(fighter.entityId, true);
  const fight = await collectMessages(fighter.outbox);
  expect(payloads(fight, 'blow').filter((blow) => blow.attackerId === fighter.entityId && blow.hit)).toHaveLength(3);
  expect(
    payloads(fight, 'condition')
      .filter((sent) => sent.entityId === ghost.id)
      .at(-1),
  ).toEqual({ entityId: ghost.id, condition: 'fallen' });
  expect(payloads(fight, 'leave')).toContainEqual({ entityId: ghost.id, leftGame: false });

  // The spawn keeps three alive. Counting the one driven off, that takes a fourth.
  for (let refill = 0; refill < 4; refill += 1) {
    clock.ms += RESPAWN_MS;
    space.step(0);
  }
  const observer = attachPlayer(space, { x: 5.12, z: 8 }, 'observer', { spaceId: 'EdariaArena' });
  const alive = entities(await collectMessages(observer.outbox)).filter((entity) => entity.kind === 'monster');
  expect(alive.map((entity) => entity.id).sort()).toEqual(['monster:2', 'monster:3', 'monster:4']);
});
