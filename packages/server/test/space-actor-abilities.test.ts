import { describe, expect, it } from 'vitest';
import { ABILITIES, distance, headingFromCardinal } from '@somnio/core';
import type { Character, Point } from '@somnio/core';
import type { SpaceActor } from '../src/world/spaceActor.ts';
import {
  BESIDE_GHOST,
  CUDGEL_IN_HAND,
  GHOST,
  GHOST_AT,
  arena,
  attackGhost,
  characterOf,
  energy,
  energyOf,
  face,
  lucidity,
  payloads,
} from './support/combat.ts';
import { collectMessages, entityMoves } from './support/frames.ts';
import { attachPlayer, makeMonsterSpawn } from './support/sectorFactory.ts';

/** A Fighter who has learned Brace, which braces them for 4 s at rank 1, and Lunge. */
const BRACER: Partial<Character> = { lucidity: lucidity('fighter', { strike: 2, guard: 1, brace: 1, lunge: 1 }) };

describe('using an ability', () => {
  it('spends its cost, starts its cooldown and the global one, shows it to everyone who sees the user, and does its deed', async () => {
    const { space } = arena({}, { ghost: false });
    const alice = attachPlayer(space, { x: 5, z: 5 }, 'alice', { character: BRACER });
    const bob = attachPlayer(space, { x: 8, z: 5 }, 'bob');
    space.handleUseAbility('brace', alice.entityId);

    expect(energyOf(space, alice.entityId).balanceCurrent).toBe(85);
    const mine = await collectMessages(alice.outbox);
    expect(payloads(mine, 'ability')).toEqual([{ entityId: alice.entityId, abilityId: 'brace' }]);
    expect(payloads(mine, 'cooldowns')).toEqual([
      { globalSeconds: 0, cooldowns: [] },
      { globalSeconds: 0.75, cooldowns: [{ abilityId: 'brace', seconds: 15 }] },
    ]);
    expect(payloads(mine, 'effects')).toEqual([{ entityId: alice.entityId, effects: [{ effectId: 'braced', seconds: 4 }] }]);
    const seen = await collectMessages(bob.outbox);
    expect(payloads(seen, 'ability')).toEqual([{ entityId: alice.entityId, abilityId: 'brace' }]);
    expect(payloads(seen, 'cooldowns')).toEqual([{ globalSeconds: 0, cooldowns: [] }]);
    expect(payloads(seen, 'effects')).toEqual([]);
  });

  it('is refused within its own cooldown, spending nothing, and taken once it is over', async () => {
    const { clock, space } = arena({}, { ghost: false });
    const alice = attachPlayer(space, { x: 5, z: 5 }, 'alice', { character: BRACER });
    space.handleUseAbility('brace', alice.entityId);
    clock.ms += 14_999;
    space.handleUseAbility('brace', alice.entityId);
    expect(energyOf(space, alice.entityId).balanceCurrent).toBe(85);
    clock.ms += 1;
    space.handleUseAbility('brace', alice.entityId);
    expect(energyOf(space, alice.entityId).balanceCurrent).toBe(70);
    expect(payloads(await collectMessages(alice.outbox), 'ability')).toHaveLength(2);
  });

  it.each([
    ['an ability no one knows', 'fireball', BRACER],
    ['an ability the dreamer has not learned', 'brace', { lucidity: lucidity('fighter', { strike: 1 }) }],
  ])('is refused for %s, spending nothing and showing nothing', async (_label, abilityId, character) => {
    const { space } = arena();
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { character });
    space.handleTarget(GHOST, alice.entityId);
    space.handleUseAbility(abilityId, alice.entityId);
    expect(energyOf(space, alice.entityId).balanceCurrent).toBe(100);
    const mine = await collectMessages(alice.outbox);
    expect(payloads(mine, 'ability')).toEqual([]);
    expect(payloads(mine, 'cooldowns')).toHaveLength(1);
  });

  it('ends its effect when the time is up, telling the holder', async () => {
    const { clock, space } = arena({}, { ghost: false });
    const alice = attachPlayer(space, { x: 5, z: 5 }, 'alice', { character: BRACER });
    space.handleUseAbility('brace', alice.entityId);
    clock.ms += 3999;
    space.step(0);
    clock.ms += 1;
    space.step(0);
    expect(payloads(await collectMessages(alice.outbox), 'effects')).toEqual([
      { entityId: alice.entityId, effects: [{ effectId: 'braced', seconds: 4 }] },
      { entityId: alice.entityId, effects: [] },
    ]);
  });
});

describe('slot 1 beside the abilities', () => {
  const blows = async (outbox: Parameters<typeof collectMessages>[0], attackerId: string) =>
    payloads(await collectMessages(outbox), 'blow').filter((blow) => blow.attackerId === attackerId);

  it('swings within the global cooldown an ability started', async () => {
    const { space, dice } = arena();
    dice.hit = false;
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { character: BRACER });
    space.handleUseAbility('brace', alice.entityId);
    attackGhost(space, alice.entityId);
    space.step(0);
    expect(await blows(alice.outbox, alice.entityId)).toHaveLength(1);
  });

  it('starts no global cooldown with its swing', () => {
    const { space, dice } = arena();
    dice.hit = false;
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { character: BRACER });
    attackGhost(space, alice.entityId);
    space.step(0);
    expect(energyOf(space, alice.entityId).balanceCurrent).toBe(92);
    space.handleUseAbility('brace', alice.entityId);
    expect(energyOf(space, alice.entityId).balanceCurrent).toBe(77);
  });
});

describe('effects shown to others', () => {
  it('reach a dreamer at once on targeting the holder and on every change after, and no other viewer', async () => {
    const { clock, space } = arena({}, { ghost: false });
    const alice = attachPlayer(space, { x: 5, z: 5 }, 'alice', { character: BRACER });
    const bob = attachPlayer(space, { x: 8, z: 5 }, 'bob');
    const carol = attachPlayer(space, { x: 5, z: 8 }, 'carol');
    space.handleUseAbility('brace', alice.entityId);
    clock.ms += 1000;
    space.handleTarget(alice.entityId, bob.entityId);
    space.handleTarget(alice.entityId, bob.entityId);
    clock.ms += 3000;
    space.step(0);
    expect(payloads(await collectMessages(bob.outbox), 'effects')).toEqual([
      { entityId: alice.entityId, effects: [{ effectId: 'braced', seconds: 3 }] },
      { entityId: alice.entityId, effects: [] },
    ]);
    expect(payloads(await collectMessages(carol.outbox), 'effects')).toEqual([]);
  });

  it('stop once the dreamer targets something else, whose own reach them at once', async () => {
    const { clock, space } = arena();
    const alice = attachPlayer(space, { x: 5, z: 5 }, 'alice', { character: BRACER });
    const bob = attachPlayer(space, { x: 8, z: 5 }, 'bob');
    space.handleUseAbility('brace', alice.entityId);
    space.handleTarget(alice.entityId, bob.entityId);
    space.handleTarget(GHOST, bob.entityId);
    clock.ms += 4000;
    space.step(0);
    expect(payloads(await collectMessages(bob.outbox), 'effects')).toEqual([
      { entityId: alice.entityId, effects: [{ effectId: 'braced', seconds: 4 }] },
      { entityId: GHOST, effects: [] },
    ]);
  });
});

/** A Ghost strikes for 9 health and 5 balance; braced, the 4.5 that reaches the dreamer is taken whole, as 5. */
describe('a strike on a braced dreamer', () => {
  it('takes half its harm, as a whole number through the real codec', async () => {
    const { space, steps } = arena();
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { character: BRACER });
    space.handleUseAbility('brace', alice.entityId);
    steps(1);
    expect(energyOf(space, alice.entityId)).toMatchObject({ healthCurrent: 95, balanceCurrent: 80 });
    expect(payloads(await collectMessages(alice.outbox), 'energy').at(-1)).toMatchObject({ healthCurrent: 95, balanceCurrent: 80 });
  });

  it('falls the dreamer it takes to none, switching slot 1 off', async () => {
    const { space, steps } = arena();
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { character: { ...BRACER, energy: energy({ healthCurrent: 5 }) } });
    space.handleUseAbility('brace', alice.entityId);
    attackGhost(space, alice.entityId);
    steps(1);
    expect(space.isFallen(alice.entityId)).toBe(true);
    steps(40);
    const swings = payloads(await collectMessages(alice.outbox), 'blow').filter((blow) => blow.attackerId === alice.entityId);
    // The swing in the step she fell in, and none after.
    expect(swings).toHaveLength(1);
  });
});

describe('Brace', () => {
  it('takes a braced dreamer reported running at a jog: no balance drained by the run, and a jog shown to everyone else', async () => {
    const { space } = arena({}, { ghost: false });
    const alice = attachPlayer(space, { x: 5, z: 5 }, 'alice', { character: BRACER });
    const bob = attachPlayer(space, { x: 15, z: 15 }, 'bob');
    space.handleUseAbility('brace', alice.entityId);
    space.handleMove({ x: 5, z: 7, facing: 0, gait: 'run' }, alice.entityId);
    space.flushMoves();
    expect(energyOf(space, alice.entityId).balanceCurrent).toBe(85);
    expect(entityMoves(await collectMessages(bob.outbox))).toEqual([{ id: alice.entityId, x: 5, z: 7, facing: 0, gait: 'jog' }]);
  });
});

describe('Cleave', () => {
  /** In front of a Fighter at `BESIDE_GHOST` facing north, beside the Ghost there; and behind them. */
  const BESIDE: Point = { x: 10.6, z: 10.3 };
  const BEHIND: Point = { x: 10, z: 11.4 };

  it('swings at every nightmare in the swing arc, for its share of the swing, and at none behind', async () => {
    const spawns = [GHOST_AT, BESIDE, BEHIND].map((at, index) => ({ ...makeMonsterSpawn(at), id: `spawn-${index + 1}` }));
    const { space, steps } = arena({ monsterSpawns: spawns });
    // Each landed cudgel swing takes 11, and Cleave's first rank 0.6 of it: 6.6, taken whole as 7.
    const fighter = attachPlayer(space, BESIDE_GHOST, 'fighter', {
      character: { lucidity: lucidity('fighter', { strike: 1, cleave: 1 }) },
      inventory: [CUDGEL_IN_HAND],
    });
    face(space, fighter.entityId, GHOST_AT);
    space.handleTarget(GHOST, fighter.entityId);
    space.handleUseAbility('cleave', fighter.entityId);
    expect(energyOf(space, fighter.entityId).balanceCurrent).toBe(84);
    steps(5);
    const messages = await collectMessages(fighter.outbox);
    expect(payloads(messages, 'ability')).toEqual([{ entityId: fighter.entityId, abilityId: 'cleave' }]);
    expect(payloads(messages, 'blow').filter((blow) => blow.attackerId === fighter.entityId)).toEqual([
      { attackerId: fighter.entityId, targetId: GHOST, hit: true },
      { attackerId: fighter.entityId, targetId: 'monster:2', hit: true },
    ]);
    expect(payloads(messages, 'vitals').at(-1)).toEqual({ entityId: GHOST, health: 0.88 });
  });
});

describe('Rally', () => {
  it("gives balance back to every standing dreamer within a said line's reach, the Fighter included, up to each maximum", () => {
    const { space } = arena({}, { ghost: false });
    const tired = { energy: energy({ balanceCurrent: 50 }) };
    const fighter = attachPlayer(space, { x: 5, z: 5 }, 'fighter', {
      character: { ...tired, lucidity: lucidity('fighter', { 'balance-recovery': 1, rally: 1 }) },
    });
    const near = attachPlayer(space, { x: 5, z: 16.9 }, 'near', { character: tired });
    const far = attachPlayer(space, { x: 5, z: 17.1 }, 'far', { character: tired });
    const fallen = attachPlayer(space, { x: 6, z: 5 }, 'fallen', { character: { energy: energy({ healthCurrent: 0, balanceCurrent: 50 }) } });
    const rested = attachPlayer(space, { x: 4, z: 5 }, 'rested', { character: { energy: energy({ balanceCurrent: 95 }) } });
    space.handleUseAbility('rally', fighter.entityId);
    expect([fighter, near, far, fallen, rested].map((slot) => energyOf(space, slot.entityId).balanceCurrent)).toEqual([60, 70, 50, 50, 100]);
  });
});

describe('Lunge', () => {
  const LUNGER: Partial<Character> = { lucidity: lucidity('fighter', { strike: 2, lunge: 1 }) };
  const STEP_MS = 100;
  /** Where the leap ends, in contact with the Ghost, and where it starts, as far off as Lunge reaches. */
  const CONTACT: Point = { x: GHOST_AT.x, z: GHOST_AT.z - 0.6 };
  const LUNGE_FROM: Point = { x: GHOST_AT.x, z: CONTACT.z - ABILITIES.lunge.range };

  /** Reports a straight line from where the dreamer stands to `to` at `metresPerSecond`, every 100 ms, as their client does. */
  function travel(space: SpaceActor, clock: { ms: number }, entityId: string, to: Point, metresPerSecond: number, gait: 'run' | 'jog'): void {
    const from = characterOf(space, entityId).position;
    const length = distance(from, to);
    const reports = Math.ceil(length / ((metresPerSecond * STEP_MS) / 1000));
    for (let index = 1; index <= reports; index += 1) {
      clock.ms += STEP_MS;
      const along = index / reports;
      space.handleMove({ x: from.x + (to.x - from.x) * along, z: from.z + (to.z - from.z) * along, facing: headingFromCardinal('south'), gait }, entityId);
      space.step(STEP_MS / 1000);
    }
  }

  /** Lunges at the Ghost and leaps to contact with it at the leap's own speed, the whole of Lunge's reach. */
  function lungeAtGhost(space: SpaceActor, clock: { ms: number }, entityId: string): void {
    space.handleTarget(GHOST, entityId);
    space.handleUseAbility('lunge', entityId);
    travel(space, clock, entityId, CONTACT, ABILITIES.lunge.does.metresPerSecond, 'jog');
  }

  it('leaps right after a sustained run with no correction', async () => {
    const { clock, space } = arena();
    const fighter = attachPlayer(space, { x: 1, z: 2 }, 'fighter', { character: LUNGER });
    travel(space, clock, fighter.entityId, { x: 18, z: 2 }, 3, 'run');
    travel(space, clock, fighter.entityId, LUNGE_FROM, 3, 'run');
    lungeAtGhost(space, clock, fighter.entityId);
    const messages = await collectMessages(fighter.outbox);
    expect(payloads(messages, 'ability')).toEqual([{ entityId: fighter.entityId, abilityId: 'lunge', targetId: GHOST }]);
    expect(payloads(messages, 'correction')).toEqual([]);
    expect(characterOf(space, fighter.entityId).position).toEqual(CONTACT);
  });

  it('leaps right after a door with no correction', async () => {
    const { clock, space } = arena();
    const fighter = attachPlayer(space, { x: 1, z: 2 }, 'fighter', { character: LUNGER });
    travel(space, clock, fighter.entityId, { x: 18, z: 2 }, 3, 'run');
    // The door's arrival: out of the space and back into it, as a transfer detaches and attaches.
    const { checkpoint, transient } = space.handOver(fighter.entityId, false)!;
    space.attach({ ...checkpoint.character, position: LUNGE_FROM }, checkpoint.inventory, fighter.outbox, 0, 'en', transient);
    lungeAtGhost(space, clock, fighter.entityId);
    const messages = await collectMessages(fighter.outbox);
    expect(payloads(messages, 'ability')).toHaveLength(1);
    expect(payloads(messages, 'correction')).toEqual([]);
    expect(characterOf(space, fighter.entityId).position).toEqual(CONTACT);
  });
});

describe('an ability at its third rank', () => {
  it('Brace holds 6 s', async () => {
    const { space } = arena({}, { ghost: false });
    const alice = attachPlayer(space, { x: 5, z: 5 }, 'alice', { character: { lucidity: lucidity('fighter', { strike: 1, guard: 1, brace: 3 }) } });
    space.handleUseAbility('brace', alice.entityId);
    expect(payloads(await collectMessages(alice.outbox), 'effects')).toEqual([{ entityId: alice.entityId, effects: [{ effectId: 'braced', seconds: 6 }] }]);
  });

  it('Lunge cools down in 6 s', async () => {
    const { space } = arena();
    const fighter = attachPlayer(space, BESIDE_GHOST, 'fighter', { character: { lucidity: lucidity('fighter', { strike: 2, lunge: 3 }) } });
    space.handleTarget(GHOST, fighter.entityId);
    space.handleUseAbility('lunge', fighter.entityId);
    expect(payloads(await collectMessages(fighter.outbox), 'cooldowns').at(-1)).toEqual({
      globalSeconds: 0.75,
      cooldowns: [{ abilityId: 'lunge', seconds: 6 }],
    });
  });

  it('Rally gives back 30', () => {
    const { space } = arena({}, { ghost: false });
    const tired = { energy: energy({ balanceCurrent: 50 }) };
    const fighter = attachPlayer(space, { x: 5, z: 5 }, 'fighter', {
      character: { ...tired, lucidity: lucidity('fighter', { 'balance-recovery': 1, rally: 3 }) },
    });
    const near = attachPlayer(space, { x: 5, z: 8 }, 'near', { character: tired });
    space.handleUseAbility('rally', fighter.entityId);
    expect([fighter, near].map((slot) => energyOf(space, slot.entityId).balanceCurrent)).toEqual([70, 80]);
  });

  it("Cleave takes the whole of the swing's damage", async () => {
    const { space, steps } = arena();
    // A landed cudgel swing takes 11, and Cleave's third rank all of it.
    const fighter = attachPlayer(space, BESIDE_GHOST, 'fighter', {
      character: { lucidity: lucidity('fighter', { strike: 1, cleave: 3 }) },
      inventory: [CUDGEL_IN_HAND],
    });
    face(space, fighter.entityId, GHOST_AT);
    space.handleTarget(GHOST, fighter.entityId);
    space.handleUseAbility('cleave', fighter.entityId);
    steps(5);
    expect(payloads(await collectMessages(fighter.outbox), 'vitals').at(-1)).toEqual({ entityId: GHOST, health: 0.82 });
  });
});
