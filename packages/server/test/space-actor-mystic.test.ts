import { describe, expect, it } from 'vitest';
import { SOMNIO_CONSTANTS, ability, boltFlightSeconds, monsterKind } from '@somnio/core';
import type { Character, ItemInstance, Point, TeachingRank } from '@somnio/core';
import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import type { Condition, SomnioMessage } from '@somnio/protocol';
import { plain } from '../../core/test/support/items.ts';
import type { SpaceActor } from '../src/world/spaceActor.ts';
import {
  BESIDE_GHOST,
  COINS,
  CUDGEL,
  GHOST,
  MOONSTONE,
  STRIKER,
  WAND,
  arena,
  attackGhost,
  carrying,
  characterOf,
  energyOf,
  engage,
  lucidity,
  payloads,
  wearing,
  wounded,
} from './support/combat.ts';
import { collectMessages, entities } from './support/frames.ts';
import { attachPlayer, makeNPC } from './support/sectorFactory.ts';

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
const coinsOf = (space: SpaceActor, entityId: string) => space.snapshotForPlayer(entityId)!.inventory.coins;
const sensed = (messages: readonly SomnioMessage[]) => payloads(messages, 'sensed').map(({ bearings }) => bearings);

describe('Ward', () => {
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
    const wand: ItemInstance = { ...WAND, rarity: 'magic', affixes: [{ affixId: 'ward-strength', value: 15 }] };
    const amulet: ItemInstance = {
      id: '00000000-0000-7000-8000-000000000021',
      ...plain('amulet'),
      rarity: 'magic',
      affixes: [{ affixId: 'ward-strength', value: 10 }],
    };
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { character: MYSTIC, inventory: wearing(wand, amulet) });
    space.handleUseAbility('ward', alice.entityId);
    steps(1);
    expect(space.handOver(alice.entityId, false)!.transient.effects).toMatchObject([{ effectId: 'warded', shield: 6 }]);
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

describe('an effect on a nightmare', () => {
  it.each(['weaken', 'bind'] as const)('from %s turns it on the Mystic who stands in its ground beyond its aggro radius', async (abilityId) => {
    const field = arena({}, { ground: 4 });
    const alice = attachPlayer(field.space, { x: 13.9, z: 10 }, 'alice', { character: MYSTIC, inventory: wearing(WAND) });
    field.steps(10);
    expect(await ghostNow(field.space)).toMatchObject({ x: 10, z: 10 });
    field.space.handleTarget(GHOST, alice.entityId);
    field.space.handleUseAbility(abilityId, alice.entityId);
    field.steps(4 * 20);
    expect((await ghostNow(field.space)).x).toBeGreaterThan(10);
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

  it('sends it home afresh once it is free, round a body in its way, however long it was held', async () => {
    const field = arena({}, { ground: 4 });
    const bob = attachPlayer(field.space, { x: 13.5, z: 10 }, 'bob');
    field.steps(30);
    const chaseEnd = await ghostNow(field.space);
    attachPlayer(field.space, { x: chaseEnd.x - 0.65, z: 10 }, 'fallen', { character: wounded(0) });
    // Outside its ground, so it chases neither of them.
    const alice = attachPlayer(field.space, { x: 10, z: 15 }, 'alice', { character: MYSTIC, inventory: wearing(WAND) });
    field.space.handleMove({ x: 15, z: 10, facing: 0, gait: 'jog' }, bob.entityId);
    // Bound while it steers home round the body, where the straight step home is still blocked.
    field.steps(3);
    const bound = await ghostNow(field.space);
    expect(bound.z).toBeGreaterThan(chaseEnd.z);
    field.space.handleTarget(GHOST, alice.entityId);
    field.space.handleUseAbility('bind', alice.entityId);
    field.steps(3 * 20 - 1);
    expect(await ghostNow(field.space)).toMatchObject({ x: bound.x, z: bound.z });
    field.steps(100);
    expect(await ghostNow(field.space)).toMatchObject({ x: 10, z: 10 });
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

  it.each([
    ['standing, shares in', 100, true],
    ['fallen while it flew, shares nothing of', 5, false],
  ] as const)('drives the nightmare off for a Mystic %s its bounty and practice', async (_label, healthCurrent, shares) => {
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
      character: { lucidity: studying, ...wounded(healthCurrent) },
      inventory: carrying({ coins: COINS, worn: [WAND] }),
    });
    space.handleTarget(GHOST, alice.entityId);
    space.handleUseAbility('dream-bolt', alice.entityId);
    steps(1);
    expect(space.isFallen(alice.entityId)).toBe(!shares);
    steps(flightSteps(0.7));
    expect((await ghostNow(space)).condition).toBe('fallen');
    expect(coinsOf(space, alice.entityId) > COINS).toBe(shares);
    expect(characterOf(space, alice.entityId).lucidity.ranks.some(({ practice }) => practice > 0)).toBe(shares);
  });

  it('is evaded by a nightmare whose ground the Mystic stands outside, landing nothing, for its cost all the same', async () => {
    const { space, steps } = arena({}, { ground: 4 });
    const outside = attachPlayer(space, { x: 10, z: 14.5 }, 'outside', { character: MYSTIC, inventory: wearing(WAND) });
    const inside = attachPlayer(space, { x: 10, z: 13.9 }, 'inside', { character: MYSTIC, inventory: wearing(WAND) });
    for (const { entityId } of [outside, inside]) space.handleTarget(GHOST, entityId);
    space.handleUseAbility('dream-bolt', outside.entityId);
    expect(energyOf(space, outside.entityId).spiritCurrent).toBe(88);
    steps(flightSteps(4.5));
    expect((await ghostNow(space)).condition).toBe('hale');
    space.handleUseAbility('dream-bolt', inside.entityId);
    steps(flightSteps(3.9));
    expect((await ghostNow(space)).condition).toBe('grazed');
    expect(payloads(await collectMessages(inside.outbox), 'ability')).toEqual([
      { entityId: outside.entityId, abilityId: 'dream-bolt', targetId: GHOST, evaded: true },
      { entityId: inside.entityId, abilityId: 'dream-bolt', targetId: GHOST },
    ]);
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

  it('takes the dreamers it veils off every table, so a nightmare that chased one from beyond its aggro radius walks home after', async () => {
    const field = arena({}, { ground: 4 });
    const alice = attachPlayer(field.space, { x: 11, z: 13.9 }, 'alice', { character: MYSTIC, inventory: wearing(WAND) });
    const bob = attachPlayer(field.space, BESIDE_GHOST, 'bob', { inventory: wearing(CUDGEL) });
    attackGhost(field.space, bob.entityId);
    field.steps(1);
    field.space.handleEngage(false, bob.entityId);
    field.space.handleMove({ x: 10, z: 13.9, facing: 0, gait: 'jog' }, bob.entityId);
    field.steps(10);
    expect((await ghostNow(field.space)).z).toBeGreaterThan(10);
    field.space.handleUseAbility('veil', alice.entityId);
    field.steps(6 * 20);
    expect(await ghostNow(field.space)).toMatchObject({ x: 10, z: 10 });
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
      npcs: [
        { ...makeNPC('tacita', { x: 4, z: 4 }, ''), service: 'mysticMaster' },
        { ...makeNPC('sana', { x: 16, z: 4 }, ''), service: 'healerMaster' },
      ],
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
