import { describe, expect, it } from 'vitest';
import { EDGE_TOLERANCE, SOMNIO_CONSTANTS, ability, boltFlightSeconds, monsterKind, rectContains } from '@somnio/core';
import type { Character, ItemInstance, Point, TeachingRank } from '@somnio/core';
import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import type { Condition, SomnioMessage } from '@somnio/protocol';
import { common } from '../../core/test/support/items.ts';
import type { SpaceActor } from '../src/world/spaceActor.ts';
import {
  BESIDE_GHOST,
  COINS,
  CUDGEL,
  GHOST,
  GHOST_AT,
  MOONSTONE,
  STRIKER,
  WAND,
  arena,
  attackGhost,
  carrying,
  characterOf,
  coinsOf,
  energyOf,
  engage,
  face,
  lucidity,
  payloads,
  setWorn,
  strikeAndLeave,
  wearing,
  wounded,
} from './support/combat.ts';
import { collectMessages, entities } from './support/frames.ts';
import { attachPlayer, makeMonsterSpawn, makeNPC } from './support/sectorFactory.ts';

/** A Mystic who has learned every ability and Sense the fallen at rank 1. */
const MYSTIC: Partial<Character> = {
  lucidity: lucidity('mystic', { ward: 1, weaken: 1, bind: 1, 'dream-bolt': 1, veil: 1, 'sense-the-fallen': 1 }),
};
/** A Ghost's strike interval, in steps of 50 ms. */
const STRIKE_STEPS = monsterKind('ghost').strikeSeconds * 20;
/** Dream-bolt's reach: the Ghost's radius and the dreamer's, and its range beyond contact. */
const BOLT_REACH = monsterKind('ghost').radius + SOMNIO_CONSTANTS.playerRadius + ability('dream-bolt').range;
/** The steps of 50 ms a bolt flies to a nightmare `metres` off before its harm lands. */
const flightSteps = (metres: number): number => Math.ceil(boltFlightSeconds(metres) * 20);

/** Where and how a dreamer who joins now is shown the Ghost. */
async function ghostNow(space: SpaceActor): Promise<Point & { facing: number; condition: Condition }> {
  const watcher = attachPlayer(space, { x: 1, z: 1 }, 'watcher');
  space.handOver(watcher.entityId, false);
  const ghost = entities(await collectMessages(watcher.outbox)).find((entity) => entity.id === GHOST)!;
  return { x: ghost.x, z: ghost.z, facing: ghost.facing, condition: ghost.condition };
}

const healthOf = (space: SpaceActor, entityId: string) => energyOf(space, entityId).healthCurrent;
const sensed = (messages: readonly SomnioMessage[]) => payloads(messages, 'sensed').map(({ bearings }) => bearings);

describe('Ward', () => {
  it('counts its Mystic among those who fought each nightmare its holder fights, so they share it from beyond the share radius', () => {
    const { clock, space } = arena();
    const bob = attachPlayer(space, BESIDE_GHOST, 'bob', { character: STRIKER, inventory: wearing(CUDGEL) });
    // 5.9 m from Bob, within Ward's reach, and 6.6 m from the Ghost, beyond its notice and the share radius.
    const alice = attachPlayer(space, { x: 10, z: 16.6 }, 'alice', { character: MYSTIC, inventory: carrying({ coins: COINS, worn: [WAND] }) });
    attackGhost(space, bob.entityId);
    space.step(0);
    space.handleTarget(bob.entityId, alice.entityId);
    space.handleUseAbility('ward', alice.entityId);
    for (let swing = 0; swing < 2; swing += 1) {
      clock.ms += 1000;
      space.step(0);
    }
    expect(coinsOf(space, alice.entityId)).toBe(COINS + monsterKind('ghost').bounty / 2);
  });

  it("takes whole hits in its holder's place until it is spent, then ends, and a hit it takes all of costs no balance", async () => {
    const { space, steps } = arena();
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { character: MYSTIC, inventory: wearing(WAND) });
    space.handleUseAbility('ward', alice.entityId);
    expect(energyOf(space, alice.entityId).spiritCurrent).toBe(85);
    steps(1);
    expect(energyOf(space, alice.entityId)).toMatchObject({ healthCurrent: 100, balanceCurrent: 100 });
    steps(STRIKE_STEPS);
    expect(energyOf(space, alice.entityId)).toMatchObject({ healthCurrent: 94, balanceCurrent: 95 });
    const messages = await collectMessages(alice.outbox);
    expect(payloads(messages, 'blow').map(({ hit }) => hit)).toEqual([true, true]);
    expect(payloads(messages, 'effects')).toEqual([
      { entityId: alice.entityId, effects: [{ effectId: 'warded', seconds: 12 }] },
      { entityId: alice.entityId, effects: [] },
    ]);
  });

  /** The Ghost's first hit, 9, comes as the ward goes up, and leaves 3 of a plain one's 12. */
  it('puts up a shield stronger by the ward strength of everything the Mystic wears', () => {
    const { space, steps } = arena();
    const wand: ItemInstance = { ...WAND, rarity: 'uncommon', affixes: [{ affixId: 'ward-strength', value: 15 }] };
    const amulet: ItemInstance = {
      id: '00000000-0000-7000-8000-000000000021',
      ...common('amulet'),
      rarity: 'uncommon',
      affixes: [{ affixId: 'ward-strength', value: 10 }],
    };
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { character: MYSTIC, inventory: wearing(wand, amulet) });
    space.handleUseAbility('ward', alice.entityId);
    steps(1);
    expect(space.handOver(alice.entityId, false)!.transient.effects).toMatchObject([{ effectId: 'warded', shield: 6 }]);
  });

  it.each([
    ['no set nor ward strength', undefined, 0, 12],
    // A quarter more.
    ['two pieces of the set', 'mystic', 0, 15],
    ['ward strength of 25', undefined, 25, 15],
    // Both, multiplied.
    ['two pieces and ward strength of 25', 'mystic', 25, 18.75],
  ] as const)('puts up a shield as strong as the set and the ward strength worn make it: %s', (_label, line, wardStrength, shield) => {
    const { space } = arena();
    const wand: ItemInstance = wardStrength === 0 ? WAND : { ...WAND, rarity: 'uncommon', affixes: [{ affixId: 'ward-strength', value: wardStrength }] };
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { character: MYSTIC, inventory: wearing(wand, ...setWorn(2, line)) });
    space.handleUseAbility('ward', alice.entityId);
    expect(space.handOver(alice.entityId, false)!.transient.effects).toMatchObject([{ effectId: 'warded', shield }]);
  });

  it('lands on the dreamer the Mystic targets', () => {
    const { space, steps } = arena();
    const alice = attachPlayer(space, { x: 10, z: 15 }, 'alice', { character: MYSTIC, inventory: wearing(WAND) });
    const bob = attachPlayer(space, BESIDE_GHOST, 'bob');
    space.handleTarget(bob.entityId, alice.entityId);
    space.handleUseAbility('ward', alice.entityId);
    steps(1);
    expect(healthOf(space, bob.entityId)).toBe(100);
  });

  it('carries what it still holds through a door', () => {
    const first = arena();
    const alice = attachPlayer(first.space, BESIDE_GHOST, 'alice', { character: MYSTIC, inventory: wearing(WAND) });
    first.space.handleUseAbility('ward', alice.entityId);
    first.steps(1);
    const carried = first.space.handOver(alice.entityId, false)!.transient;
    expect(carried.effects).toEqual([{ effectId: 'warded', seconds: 11.95, sourceId: alice.entityId, rank: 1, shield: 3 }]);

    const second = arena();
    second.space.attach(alice.character, wearing(), alice.outbox, 0, 'en', carried);
    second.steps(1);
    expect(healthOf(second.space, alice.entityId)).toBe(94);
  });
});

/** The area of a Ghost in `arena({}, { ground: 4 })`. */
const GROUND_4 = { x: 6, z: 6, width: 8, depth: 8 };
/** Beyond the aggro radius of the Ghost at `GHOST_AT`, and within the range of every ability at it. */
const FIVE_OFF: Point = { x: 10, z: 15 };

describe('an effect on a nightmare', () => {
  it.each(['weaken', 'bind'] as const)('from %s turns it on the Mystic who stands beyond its aggro radius', async (abilityId) => {
    const field = arena({}, { ground: 4 });
    const alice = attachPlayer(field.space, { x: 13.9, z: 10 }, 'alice', { character: MYSTIC, inventory: wearing(WAND) });
    field.steps(10);
    expect(await ghostNow(field.space)).toMatchObject({ x: 10, z: 10 });
    field.space.handleTarget(GHOST, alice.entityId);
    field.space.handleUseAbility(abilityId, alice.entityId);
    field.steps(4 * 20);
    expect((await ghostNow(field.space)).x).toBeGreaterThan(10);
  });

  it.each(['weaken', 'bind'] as const)(
    'from %s is evaded by a nightmare giving up, which takes neither the effect nor the Mystic onto its table',
    async (abilityId) => {
      const { space, steps } = arena();
      strikeAndLeave(space, steps);
      const alice = attachPlayer(space, FIVE_OFF, 'alice', { character: MYSTIC, inventory: wearing(WAND) });
      space.handleTarget(GHOST, alice.entityId);
      space.handleUseAbility(abilityId, alice.entityId);
      steps(8 * 20);
      const messages = await collectMessages(alice.outbox);
      expect(payloads(messages, 'ability')).toEqual([{ entityId: alice.entityId, abilityId, targetId: GHOST, evaded: true }]);
      expect(payloads(messages, 'effects')).toEqual([{ entityId: GHOST, effects: [] }]);
      expect(await ghostNow(space)).toMatchObject({ x: 10, z: 10, condition: 'hale' });
    },
  );

  it('from weaken lands on a boss at rest from outside its chamber, which evades only harm from there', async () => {
    // Its chamber is the one point it stands on, so the Mystic 4 m south of it stands outside it, within Weaken's range.
    const { space, steps } = arena({ monsterSpawns: [{ ...makeMonsterSpawn(GHOST_AT), kind: 'necromancer' }] });
    const alice = attachPlayer(space, { x: 10, z: 14 }, 'alice', { character: MYSTIC, inventory: wearing(WAND) });
    space.handleTarget(GHOST, alice.entityId);
    space.handleUseAbility('weaken', alice.entityId);
    steps(1);
    const messages = await collectMessages(alice.outbox);
    expect(payloads(messages, 'ability')).toEqual([{ entityId: alice.entityId, abilityId: 'weaken', targetId: GHOST }]);
    expect(payloads(messages, 'effects')).toEqual([
      { entityId: GHOST, effects: [] },
      { entityId: GHOST, effects: [{ effectId: 'weakened', seconds: 8 }] },
    ]);
  });

  it('from a Veiled Mystic at rest counts them in no fight it begins after, so they share nothing of its fall', () => {
    const { clock, space } = arena();
    // 6.5 m off: within Weaken's reach, beyond its notice and the share radius.
    const alice = attachPlayer(space, { x: 10, z: 16.5 }, 'alice', { character: MYSTIC, inventory: carrying({ coins: COINS, worn: [WAND] }) });
    space.handleUseAbility('veil', alice.entityId);
    clock.ms += 1000;
    space.handleTarget(GHOST, alice.entityId);
    space.handleUseAbility('weaken', alice.entityId);
    space.step(0);
    const bob = attachPlayer(space, BESIDE_GHOST, 'bob', { character: STRIKER, inventory: wearing(CUDGEL) });
    attackGhost(space, bob.entityId);
    for (let swing = 0; swing < 3; swing += 1) {
      clock.ms += 1000;
      space.step(0);
    }
    expect([alice, bob].map((player) => coinsOf(space, player.entityId))).toEqual([COINS, monsterKind('ghost').bounty]);
  });
});

describe('Weaken', () => {
  it('softens the strikes of the nightmare it lands on, and shows it on the frame of whoever targets it', async () => {
    const { space, steps } = arena();
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { character: MYSTIC, inventory: wearing(WAND) });
    space.handleTarget(GHOST, alice.entityId);
    space.handleUseAbility('weaken', alice.entityId);
    steps(1);
    expect(healthOf(space, alice.entityId)).toBe(95);
    steps(8 * 20);
    expect(payloads(await collectMessages(alice.outbox), 'effects')).toEqual([
      { entityId: GHOST, effects: [] },
      { entityId: GHOST, effects: [{ effectId: 'weakened', seconds: 8 }] },
      { entityId: GHOST, effects: [] },
    ]);
  });

  it('is refused at no nightmare', () => {
    const { space } = arena();
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { character: MYSTIC, inventory: wearing(WAND) });
    space.handleUseAbility('weaken', alice.entityId);
    expect(energyOf(space, alice.entityId).spiritCurrent).toBe(100);
  });
});

describe('Bind', () => {
  it('holds the nightmare where it stands for its seconds, turned toward whom it chases, and then lets it chase', async () => {
    const field = arena({}, { ground: 4 });
    const alice = attachPlayer(field.space, { x: 12.5, z: 10 }, 'alice', { character: MYSTIC, inventory: wearing(WAND) });
    expect((await ghostNow(field.space)).facing).toBe(0);
    field.space.handleTarget(GHOST, alice.entityId);
    field.space.handleUseAbility('bind', alice.entityId);
    field.steps(2 * 20);
    expect(await ghostNow(field.space)).toMatchObject({ x: 10, z: 10, facing: 90 });
    field.steps(20);
    expect((await ghostNow(field.space)).x).toBeGreaterThan(10);
  });

  it('sends it home afresh once it is free, still evading, round a body in its way, however long it was held', async () => {
    const field = arena({}, { ground: 4 });
    const bob = attachPlayer(field.space, { x: 13.5, z: 10 }, 'bob');
    field.steps(10);
    field.space.handleMove({ x: 16, z: 10, facing: 0, gait: 'jog' }, bob.entityId);
    field.steps(40);
    // Out of its area, with a body across the straight step home.
    const chaseEnd = await ghostNow(field.space);
    expect(rectContains(GROUND_4, chaseEnd, EDGE_TOLERANCE)).toBe(false);
    attachPlayer(field.space, { x: chaseEnd.x - 0.65, z: 10 }, 'fallen', { character: wounded(0) });
    const alice = attachPlayer(field.space, { x: chaseEnd.x, z: 15 }, 'alice', { character: MYSTIC, inventory: wearing(WAND) });
    field.space.handleTarget(GHOST, alice.entityId);
    field.space.handleUseAbility('bind', alice.entityId);
    // Bound, it gives up as both leave, and holds through the Bind.
    field.space.handOver(bob.entityId, false);
    field.space.handOver(alice.entityId, false);
    field.steps(3 * 20 - 1);
    expect(await ghostNow(field.space)).toMatchObject({ x: chaseEnd.x, z: chaseEnd.z });
    // Free, it is still evading: the Bind's seconds were no stall on its way home.
    field.steps(1);
    const carol = attachPlayer(field.space, { x: chaseEnd.x + 0.7, z: 10 }, 'carol', {
      character: { lucidity: lucidity('fighter', { strike: 1, cleave: 1 }) },
      inventory: wearing(CUDGEL),
    });
    face(field.space, carol.entityId, chaseEnd);
    field.space.handleUseAbility('cleave', carol.entityId);
    field.space.handOver(carol.entityId, false);
    expect(payloads(await collectMessages(carol.outbox), 'blow')).toEqual([{ attackerId: carol.entityId, targetId: GHOST, hit: false, evaded: true }]);
    field.steps(60);
    expect(rectContains(GROUND_4, await ghostNow(field.space), EDGE_TOLERANCE)).toBe(true);
  });

  it.each([
    ['no set', undefined, [{ effectId: 'bound', seconds: 3 }]],
    [
      'six pieces',
      'mystic',
      [
        { effectId: 'bound', seconds: 3 },
        { effectId: 'weakened', seconds: 8 },
      ],
    ],
  ] as const)('puts its effects on the nightmare by the set its Mystic wears: %s', async (_label, line, effects) => {
    const { space } = arena();
    const alice = attachPlayer(space, FIVE_OFF, 'alice', { character: MYSTIC, inventory: wearing(WAND, ...setWorn(6, line)) });
    space.handleTarget(GHOST, alice.entityId);
    space.handleUseAbility('bind', alice.entityId);
    expect(payloads(await collectMessages(alice.outbox), 'effects').at(-1)).toEqual({ entityId: GHOST, effects });
  });

  it('with six pieces of the set leaves a longer Weaken the nightmare holds as it is', async () => {
    const { space, steps } = arena();
    const character = { lucidity: lucidity('mystic', { weaken: 3, bind: 1 }) };
    const alice = attachPlayer(space, FIVE_OFF, 'alice', { character, inventory: wearing(WAND, ...setWorn(6, 'mystic')) });
    space.handleTarget(GHOST, alice.entityId);
    space.handleUseAbility('weaken', alice.entityId);
    steps(2 * 20);
    space.handleUseAbility('bind', alice.entityId);
    const shown = payloads(await collectMessages(alice.outbox), 'effects').map(({ effects }) => effects);
    // The rank-3 Weaken's 12 s, 2 s spent, outlast the 8 s a rank-1 Bind's would give.
    expect(shown.at(-2)).toEqual([{ effectId: 'weakened', seconds: 12 }]);
    expect(shown.at(-1)).toEqual([
      { effectId: 'weakened', seconds: 10 },
      { effectId: 'bound', seconds: 3 },
    ]);
  });

  it('with six pieces of the set puts a Weaken on afresh over a shorter one the nightmare holds', async () => {
    const { space, steps } = arena();
    const character = { lucidity: lucidity('mystic', { weaken: 1, bind: 1 }) };
    const alice = attachPlayer(space, FIVE_OFF, 'alice', { character, inventory: wearing(WAND, ...setWorn(6, 'mystic')) });
    space.handleTarget(GHOST, alice.entityId);
    space.handleUseAbility('weaken', alice.entityId);
    steps(5 * 20);
    space.handleUseAbility('bind', alice.entityId);
    const shown = payloads(await collectMessages(alice.outbox), 'effects').map(({ effects }) => effects);
    // The rank-1 Weaken's 8 s, 5 s spent, fall short of the 8 s the Bind's would give.
    expect(shown.at(-1)).toEqual([
      { effectId: 'bound', seconds: 3 },
      { effectId: 'weakened', seconds: 8 },
    ]);
  });

  it('with six pieces of the set Weakens an elite too, whose trait lasts as long as it stands', async () => {
    const { space } = arena({}, { elite: 'stony' });
    const alice = attachPlayer(space, FIVE_OFF, 'alice', { character: MYSTIC, inventory: wearing(WAND, ...setWorn(6, 'mystic')) });
    space.handleTarget(GHOST, alice.entityId);
    space.handleUseAbility('bind', alice.entityId);
    const last = payloads(await collectMessages(alice.outbox), 'effects').at(-1)!.effects;
    expect(last.map(({ effectId }) => effectId).sort()).toEqual(['bound', 'stony', 'weakened']);
  });

  it('with six pieces of the set is evaded whole by a nightmare giving up, Weaken included', async () => {
    const { space, steps } = arena();
    strikeAndLeave(space, steps);
    const alice = attachPlayer(space, FIVE_OFF, 'alice', { character: MYSTIC, inventory: wearing(WAND, ...setWorn(6, 'mystic')) });
    space.handleTarget(GHOST, alice.entityId);
    space.handleUseAbility('bind', alice.entityId);
    expect(payloads(await collectMessages(alice.outbox), 'effects')).toEqual([{ entityId: GHOST, effects: [] }]);
  });

  it('leaves it striking whoever stands in its reach', () => {
    const { space, steps } = arena();
    const alice = attachPlayer(space, { x: 10, z: 13 }, 'alice', { character: MYSTIC, inventory: wearing(WAND) });
    const bob = attachPlayer(space, BESIDE_GHOST, 'bob');
    space.handleTarget(GHOST, alice.entityId);
    space.handleUseAbility('bind', alice.entityId);
    steps(1);
    expect(healthOf(space, bob.entityId)).toBe(91);
  });

  it('has its caster share the nightmare another drives off, from beyond the share radius', () => {
    const { clock, space } = arena();
    // 6.5 m off: within Bind's reach, beyond the share radius.
    const alice = attachPlayer(space, { x: 10, z: 16.5 }, 'alice', { character: MYSTIC, inventory: carrying({ coins: COINS, worn: [WAND] }) });
    const bob = attachPlayer(space, BESIDE_GHOST, 'bob', { character: STRIKER, inventory: wearing(CUDGEL) });
    space.handleTarget(GHOST, alice.entityId);
    space.handleUseAbility('bind', alice.entityId);
    attackGhost(space, bob.entityId);
    for (let swing = 0; swing < 3; swing += 1) {
      space.step(0);
      clock.ms += 1000;
    }
    expect(coinsOf(space, alice.entityId)).toBe(COINS + monsterKind('ghost').bounty / 2);
  });
});

describe('Dream-bolt', () => {
  it('harms the nightmare from as far as its range beyond contact, whatever the Mystic holds, and no further', async () => {
    const { space, steps } = arena({}, { ground: 9 });
    const near = attachPlayer(space, { x: 10, z: 10 + BOLT_REACH - 0.05 }, 'near', { character: MYSTIC, inventory: wearing(CUDGEL, WAND) });
    const far = attachPlayer(space, { x: 10 + BOLT_REACH + 0.05, z: 10 }, 'far', { character: MYSTIC, inventory: wearing(WAND) });
    for (const { entityId } of [near, far]) {
      space.handleTarget(GHOST, entityId);
      space.handleUseAbility('dream-bolt', entityId);
    }
    expect(energyOf(space, near.entityId).spiritCurrent).toBe(88);
    expect(energyOf(space, far.entityId).spiritCurrent).toBe(100);
    steps(flightSteps(BOLT_REACH));
    expect(payloads(await collectMessages(near.outbox), 'vitals').at(-1)).toEqual({ entityId: GHOST, health: 0.8 });
  });

  it.each([
    // Its 12 harm whole on an ordinary Ghost's 60.
    ['an ordinary Ghost', undefined, 0.8],
    // Stony takes 0.6 of it, 7, from the elite's 150.
    ['a Stony elite', 'stony', 0.95],
    // The shield takes all of it.
    ['a Shielded elite', 'shielded', 1],
  ] as const)('lands on a nightmare by its trait and its health: %s', async (_label, trait, share) => {
    const { space, steps } = arena({}, trait === undefined ? { ground: 9 } : { ground: 9, elite: trait });
    const alice = attachPlayer(space, { x: 10, z: 15 }, 'alice', { character: MYSTIC, inventory: wearing(WAND) });
    space.handleTarget(GHOST, alice.entityId);
    space.handleUseAbility('dream-bolt', alice.entityId);
    steps(flightSteps(5));
    expect(payloads(await collectMessages(alice.outbox), 'vitals').at(-1)).toEqual({ entityId: GHOST, health: share });
  });

  it.each([
    // Its 12 harm whole on the Ghost's 60.
    ['no set', undefined, 0.8],
    // A fifth more, 14.4, taken whole as 14.
    ['four pieces', 'mystic', 0.77],
  ] as const)('harms by the set its Mystic wears: %s', async (_label, line, health) => {
    const { space, steps } = arena({}, { ground: 9 });
    const alice = attachPlayer(space, { x: 10, z: 15 }, 'alice', { character: MYSTIC, inventory: wearing(WAND, ...setWorn(4, line)) });
    space.handleTarget(GHOST, alice.entityId);
    space.handleUseAbility('dream-bolt', alice.entityId);
    steps(flightSteps(5));
    expect(payloads(await collectMessages(alice.outbox), 'vitals').at(-1)).toEqual({ entityId: GHOST, health });
  });

  it('lands its harm as the bolt arrives, the flight after the use, and not before', async () => {
    const { space, steps } = arena({}, { ground: 9 });
    const alice = attachPlayer(space, { x: 10, z: 15 }, 'alice', { character: MYSTIC, inventory: wearing(WAND) });
    space.handleTarget(GHOST, alice.entityId);
    space.handleUseAbility('dream-bolt', alice.entityId);
    expect(energyOf(space, alice.entityId).spiritCurrent).toBe(88);
    steps(flightSteps(5) - 1);
    expect((await ghostNow(space)).condition).toBe('hale');
    steps(1);
    expect((await ghostNow(space)).condition).toBe('grazed');
  });

  it('turns the nightmare on the Mystic from outside its aggro radius as the bolt lands', async () => {
    const field = arena({}, { ground: 4 });
    const alice = attachPlayer(field.space, { x: 10, z: 13.9 }, 'alice', { character: MYSTIC, inventory: wearing(WAND) });
    field.steps(10);
    expect((await ghostNow(field.space)).z).toBe(10);
    field.space.handleTarget(GHOST, alice.entityId);
    field.space.handleUseAbility('dream-bolt', alice.entityId);
    field.steps(flightSteps(3.9) - 1);
    expect((await ghostNow(field.space)).z).toBe(10);
    field.steps(10);
    expect((await ghostNow(field.space)).z).toBeGreaterThan(10);
  });

  it('lands nothing on a nightmare another bolt drove off while it flew', () => {
    const { space, clock, steps } = arena({}, { ground: 9 });
    const alice = attachPlayer(space, { x: 10, z: 15 }, 'alice', { character: MYSTIC, inventory: carrying({ coins: COINS, worn: [WAND] }) });
    const bob = attachPlayer(space, BESIDE_GHOST, 'bob', { character: MYSTIC, inventory: carrying({ coins: COINS, worn: [WAND] }) });
    for (const { entityId } of [alice, bob]) space.handleTarget(GHOST, entityId);
    // Four bolts leave the Ghost 12 of its 60, all landing in one step.
    for (let bolt = 0; bolt < 4; bolt += 1) {
      space.handleUseAbility('dream-bolt', alice.entityId);
      clock.ms += 3000;
    }
    space.step(0);
    const before = coinsOf(space, alice.entityId);
    space.handleUseAbility('dream-bolt', alice.entityId);
    space.handleUseAbility('dream-bolt', bob.entityId);
    steps(flightSteps(0.7));
    expect(coinsOf(space, alice.entityId)).toBe(before + monsterKind('ghost').bounty / 2);
    steps(flightSteps(5));
    expect(coinsOf(space, alice.entityId)).toBe(before + monsterKind('ghost').bounty / 2);
  });

  it('drives the nightmare off at none, paying the Mystic who did it from beyond the share radius', async () => {
    const { space, clock } = arena({}, { ground: 9 });
    const alice = attachPlayer(space, { x: 10, z: 18 }, 'alice', { character: MYSTIC, inventory: carrying({ coins: COINS, worn: [WAND] }) });
    space.handleTarget(GHOST, alice.entityId);
    for (let bolt = 0; bolt < 5; bolt += 1) {
      space.handleUseAbility('dream-bolt', alice.entityId);
      clock.ms += 3000;
    }
    space.step(0);
    expect(payloads(await collectMessages(alice.outbox), 'condition').at(-1)).toEqual({ entityId: GHOST, condition: 'fallen' });
    expect(coinsOf(space, alice.entityId)).toBe(COINS + monsterKind('ghost').bounty);
  });

  it('drives the nightmare off for a Mystic fallen while it flew, who still shares in its bounty and practice', async () => {
    const { space, clock, steps } = arena({}, { ground: 9 });
    const bob = attachPlayer(space, { x: 10, z: 15 }, 'bob', { character: MYSTIC, inventory: wearing(WAND) });
    space.handleTarget(GHOST, bob.entityId);
    // Four bolts leave the Ghost 12 of its 60, all landing in one step.
    for (let bolt = 0; bolt < 4; bolt += 1) {
      space.handleUseAbility('dream-bolt', bob.entityId);
      clock.ms += 3000;
    }
    space.step(0);
    const studying = lucidity('mystic', { ward: 1, 'dream-bolt': 1 }, { study: 'ward' });
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', {
      character: { lucidity: studying, ...wounded(5) },
      inventory: carrying({ coins: COINS, worn: [WAND] }),
    });
    space.handleTarget(GHOST, alice.entityId);
    space.handleUseAbility('dream-bolt', alice.entityId);
    steps(1);
    expect(space.isFallen(alice.entityId)).toBe(true);
    steps(flightSteps(0.7));
    expect((await ghostNow(space)).condition).toBe('fallen');
    expect(coinsOf(space, alice.entityId)).toBeGreaterThan(COINS);
    expect(characterOf(space, alice.entityId).lucidity.ranks.some(({ practice }) => practice > 0)).toBe(true);
  });

  it('lands from outside the spawn area of a nightmare at rest, which then chases the Mystic', async () => {
    const { space, steps } = arena({}, { ground: 1 });
    // 7 m off, outside its area and its aggro radius.
    const alice = attachPlayer(space, { x: 10, z: 17 }, 'alice', { character: MYSTIC, inventory: wearing(WAND) });
    space.handleTarget(GHOST, alice.entityId);
    space.handleUseAbility('dream-bolt', alice.entityId);
    steps(flightSteps(7));
    expect((await ghostNow(space)).condition).toBe('grazed');
    steps(10);
    expect((await ghostNow(space)).z).toBeGreaterThan(10);
    expect(payloads(await collectMessages(alice.outbox), 'ability')).toEqual([{ entityId: alice.entityId, abilityId: 'dream-bolt', targetId: GHOST }]);
  });

  it('is evaded by a nightmare giving up, landing nothing, its threat included, for its cost all the same', async () => {
    const { space, steps } = arena();
    strikeAndLeave(space, steps);
    const alice = attachPlayer(space, FIVE_OFF, 'alice', { character: MYSTIC, inventory: wearing(WAND) });
    space.handleTarget(GHOST, alice.entityId);
    space.handleUseAbility('dream-bolt', alice.entityId);
    expect(energyOf(space, alice.entityId).spiritCurrent).toBe(88);
    steps(8 * 20);
    expect(payloads(await collectMessages(alice.outbox), 'ability')).toEqual([
      { entityId: alice.entityId, abilityId: 'dream-bolt', targetId: GHOST, evaded: true },
    ]);
    expect(await ghostNow(space)).toMatchObject({ x: 10, z: 10, condition: 'hale' });
  });

  /** It gives up 2.8 m from home, a longer walk back than the bolt's flight. */
  it('lands nothing on a nightmare that gave up while it flew, which then chases no one', async () => {
    const { space, steps } = arena();
    // Within its notice, east of it, where it closes on him and fights him.
    const bob = attachPlayer(space, { x: 13.5, z: 10 }, 'bob');
    steps(30);
    const fighting = await ghostNow(space);
    expect(fighting.x).toBeGreaterThan(12.5);
    // 7 m off, beyond its aggro radius.
    const alice = attachPlayer(space, { x: fighting.x, z: fighting.z + 7 }, 'alice', { character: MYSTIC, inventory: wearing(WAND) });
    space.handleTarget(GHOST, alice.entityId);
    space.handleUseAbility('dream-bolt', alice.entityId);
    space.handOver(bob.entityId, false);
    steps(flightSteps(7));
    expect(await ghostNow(space)).toMatchObject({ condition: 'hale' });
    steps(60);
    expect(await ghostNow(space)).toMatchObject({ x: 10, z: 10, condition: 'hale' });
    expect(payloads(await collectMessages(alice.outbox), 'ability')).toEqual([{ entityId: alice.entityId, abilityId: 'dream-bolt', targetId: GHOST }]);
  });

  it('lands nothing once its caster has left the space', async () => {
    const { space, steps } = arena({}, { ground: 9 });
    const alice = attachPlayer(space, { x: 10, z: 15 }, 'alice', { character: MYSTIC, inventory: wearing(WAND) });
    const bob = attachPlayer(space, { x: 15, z: 10 }, 'bob', { character: MYSTIC, inventory: wearing(WAND) });
    for (const { entityId } of [alice, bob]) {
      space.handleTarget(GHOST, entityId);
      space.handleUseAbility('dream-bolt', entityId);
    }
    space.handOver(alice.entityId, false);
    steps(flightSteps(5));
    expect(payloads(await collectMessages(bob.outbox), 'vitals').at(-1)).toEqual({ entityId: GHOST, health: 0.8 });
  });
});

describe('Veil', () => {
  it("takes every standing dreamer near the Mystic off the nightmares' minds for its seconds", () => {
    const { space, steps } = arena();
    const alice = attachPlayer(space, { x: 10, z: 12 }, 'alice', { character: MYSTIC, inventory: wearing(WAND) });
    const bob = attachPlayer(space, BESIDE_GHOST, 'bob', { inventory: wearing(CUDGEL) });
    attackGhost(space, bob.entityId);
    steps(1);
    expect(healthOf(space, bob.entityId)).toBe(91);
    space.handleUseAbility('veil', alice.entityId);
    steps(5 * 20 - 1);
    expect(healthOf(space, bob.entityId)).toBe(93);
    steps(2);
    expect(healthOf(space, bob.entityId)).toBe(84);
  });

  it('takes the dreamers it veils off every table, so a nightmare that chased one out of its area gives up and walks back into it', async () => {
    const field = arena({}, { ground: 4 });
    const bob = attachPlayer(field.space, BESIDE_GHOST, 'bob', { inventory: wearing(CUDGEL) });
    attackGhost(field.space, bob.entityId);
    field.steps(1);
    field.space.handleEngage(false, bob.entityId);
    field.space.handleMove({ x: 10, z: 15.5, facing: 0, gait: 'jog' }, bob.entityId);
    field.steps(40);
    expect(rectContains(GROUND_4, await ghostNow(field.space), EDGE_TOLERANCE)).toBe(false);
    // Within a Veil's reach of Bob, joining as the Veil goes up.
    const alice = attachPlayer(field.space, { x: 11, z: 15.5 }, 'alice', { character: MYSTIC, inventory: wearing(WAND) });
    field.space.handleUseAbility('veil', alice.entityId);
    field.steps(3 * 20);
    expect(rectContains(GROUND_4, await ghostNow(field.space), EDGE_TOLERANCE)).toBe(true);
  });

  it('leaves alone a dreamer beyond its reach', () => {
    const { space, steps } = arena();
    const alice = attachPlayer(space, { x: 10, z: 16 }, 'alice', { character: MYSTIC, inventory: wearing(WAND) });
    const bob = attachPlayer(space, BESIDE_GHOST, 'bob');
    space.handleUseAbility('veil', alice.entityId);
    steps(1);
    expect(healthOf(space, bob.entityId)).toBe(91);
  });
});

describe('Sense the fallen', () => {
  it('shows a Mystic who senses where each fallen dreamer lies: at once on joining, and again on a fall and a going', async () => {
    const { space, steps } = arena();
    const alice = attachPlayer(space, { x: 2, z: 2 }, 'alice', { character: MYSTIC, inventory: wearing(WAND) });
    const plain = attachPlayer(space, { x: 3, z: 2 }, 'plain', { character: { lucidity: lucidity('mystic', { ward: 1 }) } });
    const bob = attachPlayer(space, BESIDE_GHOST, 'bob', { character: wounded(5) });
    steps(1);
    expect(space.isFallen(bob.entityId)).toBe(true);
    space.handOver(bob.entityId, false);
    expect(sensed(await collectMessages(alice.outbox))).toEqual([[], [{ name: 'bob', ...BESIDE_GHOST }], []]);
    expect(sensed(await collectMessages(plain.outbox))).toEqual([]);
  });

  it('shows a Mystic who joins a dreamer already fallen, and the Mystics there one who joins fallen', async () => {
    const { space } = arena({}, { ghost: false });
    const bob = attachPlayer(space, { x: 5, z: 5 }, 'bob', { character: wounded(0) });
    const alice = attachPlayer(space, { x: 2, z: 2 }, 'alice', { character: MYSTIC, inventory: wearing(WAND) });
    attachPlayer(space, { x: 8, z: 8 }, 'carol', { character: wounded(0) });
    expect(sensed(await collectMessages(alice.outbox))).toEqual([
      [{ name: 'bob', x: 5, z: 5 }],
      [
        { name: 'bob', x: 5, z: 5 },
        { name: 'carol', x: 8, z: 8 },
      ],
    ]);
    expect(sensed(await collectMessages(bob.outbox))).toEqual([]);
  });

  it('shows a Mystic that a dreamer raised lies fallen no more', async () => {
    const { space, steps } = arena({}, { ghost: false });
    const bob = attachPlayer(space, { x: 5, z: 5.7 }, 'bob', { character: wounded(0) });
    const alice = attachPlayer(space, { x: 2, z: 2 }, 'alice', { character: MYSTIC, inventory: wearing(WAND) });
    const healer = attachPlayer(space, { x: 5, z: 5 }, 'healer', {
      character: { lucidity: lucidity('healer', { touch: 2, 'drawing-back': 1 }) },
      inventory: wearing(MOONSTONE),
    });
    engage(space, bob.entityId, healer.entityId);
    steps(200);
    expect(space.isFallen(bob.entityId)).toBe(false);
    expect(sensed(await collectMessages(alice.outbox))).toEqual([[{ name: 'bob', x: 5, z: 5.7 }], []]);
  });

  it('shows the nearest of the fallen first, and no more of them than one frame carries', async () => {
    const { space } = arena({}, { ghost: false });
    // Joined farthest first, so the order they joined in is the reverse of nearest first.
    const fallen = Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxSensedBearings + 1 }, (_, index) => ({
      name: `fallen-${index}`,
      x: 18 - index * 0.5,
      z: 2,
    }));
    for (const { name, x, z } of fallen) attachPlayer(space, { x, z }, name, { character: wounded(0) });
    const alice = attachPlayer(space, { x: 1, z: 2 }, 'alice', { character: MYSTIC, inventory: wearing(WAND) });
    expect(sensed(await collectMessages(alice.outbox))).toEqual([fallen.slice(1).reverse()]);
  });

  it('shows a Mystic where the fallen lie the moment they learn it', async () => {
    const { space, clock } = arena();
    const studying: TeachingRank[] = [
      { teachingId: 'ward', rank: 1, practice: 0 },
      { teachingId: 'sense-the-fallen', rank: 0, practice: 15 },
    ];
    const alice = attachPlayer(space, { x: 10, z: 13 }, 'alice', {
      character: { lucidity: lucidity('mystic', {}, { ranks: studying, study: 'sense-the-fallen' }) },
    });
    attachPlayer(space, { x: 5, z: 5 }, 'bob', { character: wounded(0) });
    const carol = attachPlayer(space, BESIDE_GHOST, 'carol', { character: STRIKER, inventory: wearing(CUDGEL) });
    attackGhost(space, carol.entityId);
    for (let swing = 0; swing < 3; swing += 1) {
      space.step(0);
      clock.ms += 1000;
    }
    expect(sensed(await collectMessages(alice.outbox))).toEqual([[{ name: 'bob', x: 5, z: 5 }]]);
  });
});

describe('the Mystic master', () => {
  const TACITA = 'npc:TestSector/tacita';
  const AT_TACITA: Point = { x: 4, z: 5 };
  const tower = () =>
    arena({
      npcs: [makeNPC('tacita', { x: 4, z: 4 }, {}, 'mysticMaster'), makeNPC('sana', { x: 16, z: 4 }, {}, 'healerMaster')],
    });

  it("teaches a Mystic the Mystic's teachings, and no other role's", () => {
    const { space } = tower();
    const alice = attachPlayer(space, AT_TACITA, 'alice', { character: { lucidity: lucidity('mystic', { ward: 1 }) } });
    space.handleStudy(TACITA, 'deep-mend', alice.entityId);
    expect(characterOf(space, alice.entityId).lucidity.study).toBeUndefined();
    space.handleStudy(TACITA, 'weaken', alice.entityId);
    expect(characterOf(space, alice.entityId).lucidity.study).toBe('weaken');
  });

  it('teaches no other role, and the other masters teach no Mystic', () => {
    const { space } = tower();
    const healer = attachPlayer(space, AT_TACITA, 'healer', { character: { lucidity: lucidity('healer', { touch: 1 }) } });
    space.handleStudy(TACITA, 'ward', healer.entityId);
    expect(characterOf(space, healer.entityId).lucidity.study).toBeUndefined();
    const mystic = attachPlayer(space, { x: 16, z: 5 }, 'mystic', { character: { lucidity: lucidity('mystic', { ward: 1 }) } });
    space.handleStudy('npc:TestSector/sana', 'weaken', mystic.entityId);
    expect(characterOf(space, mystic.entityId).lucidity.study).toBeUndefined();
  });
});
