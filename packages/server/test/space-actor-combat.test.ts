import { describe, expect, it } from 'vitest';
import { OUTDOOR_SPACE_ID } from '@somnio/core';
import type { Character, InventoryRow, Point } from '@somnio/core';
import type { SomnioMessage } from '@somnio/protocol';
import { ConnectionOutbox } from '../src/connection/outbox.ts';
import type { SpaceActor } from '../src/world/spaceActor.ts';
import { seededRandom } from '../src/world/random.ts';
import {
  BESIDE_GHOST,
  CUDGEL_IN_HAND,
  GHOST,
  GHOST_AT,
  MOONSTONE_IN_HAND,
  RESPAWN_MS,
  STRIKER,
  arena,
  attackGhost,
  characterOf,
  energy,
  energyOf,
  engage,
  face,
  lucidity,
  PURSE,
  payloads,
} from './support/combat.ts';
import { collectMessages, entities, entityMoves, serverSays, vitalsOutbox } from './support/frames.ts';
import { attachPlayer, makeClockedSpace, makeMonsterSpawn, makeNPC, makeSector, makeWorld } from './support/sectorFactory.ts';

describe('attacking a nightmare', () => {
  const blowsBy = (messages: readonly SomnioMessage[], attackerId: string) => payloads(messages, 'blow').filter((blow) => blow.attackerId === attackerId);

  it.each([
    ['bare hands', [], 8],
    ['the cudgel', [CUDGEL_IN_HAND], 18],
  ])(
    'swings at the target once per swing interval while Attack is on, each for the balance %s cost, and a miss costs it too',
    async (_label, inventory, cost) => {
      const { clock, space, dice } = arena();
      dice.hit = false;
      const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { inventory });
      attackGhost(space, alice.entityId);
      space.step(0);
      expect(energyOf(space, alice.entityId).balanceCurrent).toBe(100 - cost);
      clock.ms += 999;
      space.step(0);
      expect(energyOf(space, alice.entityId).balanceCurrent).toBe(100 - cost);
      clock.ms += 1;
      space.step(0);
      expect(energyOf(space, alice.entityId).balanceCurrent).toBe(100 - 2 * cost);
      const messages = await collectMessages(alice.outbox);
      const miss = { attackerId: alice.entityId, targetId: GHOST, hit: false };
      expect(blowsBy(messages, alice.entityId)).toEqual([miss, miss]);
      expect(payloads(messages, 'condition')).toEqual([]);
    },
  );

  it.each([
    ['with less balance than the swing costs', { character: { energy: energy({ balanceCurrent: 7 }) } }],
    ['with the Moonstone in hand', { inventory: [MOONSTONE_IN_HAND] }],
  ])('does not swing %s', async (_label, options) => {
    const { space, dice } = arena();
    dice.hit = false;
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', options);
    const before = energyOf(space, alice.entityId);
    attackGhost(space, alice.entityId);
    space.step(0);
    expect(energyOf(space, alice.entityId)).toEqual(before);
    expect(blowsBy(await collectMessages(alice.outbox), alice.entityId)).toEqual([]);
  });

  it('spends nothing while the target stands out of reach, and swings once the dreamer steps into reach', async () => {
    const { clock, space, dice } = arena();
    dice.hit = false;
    const alice = attachPlayer(space, { x: 10, z: 10.9 }, 'alice');
    attackGhost(space, alice.entityId);
    space.step(0);
    clock.ms += 1000;
    space.step(0);
    expect(energyOf(space, alice.entityId).balanceCurrent).toBe(100);
    space.handleMove({ ...BESIDE_GHOST, facing: 180, gait: 'walk' }, alice.entityId);
    space.step(0);
    expect(energyOf(space, alice.entityId).balanceCurrent).toBe(92);
    expect(blowsBy(await collectMessages(alice.outbox), alice.entityId)).toHaveLength(1);
  });

  it('swings at nothing while the target stands behind the dreamer, and swings once they turn to it', async () => {
    const { space, dice } = arena();
    dice.hit = false;
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice');
    // She faces south, away from the Ghost north of her.
    engage(space, GHOST, alice.entityId);
    space.step(0);
    expect(energyOf(space, alice.entityId).balanceCurrent).toBe(100);
    face(space, alice.entityId, GHOST_AT);
    space.step(0);
    expect(energyOf(space, alice.entityId).balanceCurrent).toBe(92);
    expect(blowsBy(await collectMessages(alice.outbox), alice.entityId)).toHaveLength(1);
  });

  it.each<[string, (space: SpaceActor, aliceId: string, bobId: string) => void]>([
    ['without a target', () => {}],
    ['with an NPC as the target', (space, aliceId) => space.handleTarget('npc:TestSector/guard', aliceId)],
    ['with another dreamer as the target', (space, aliceId, bobId) => space.handleTarget(bobId, aliceId)],
  ])('refuses slot 1 %s, swinging at nothing, not even the nightmare in reach in front', async (_label, choose) => {
    const { clock, space, dice } = arena({ npcs: [makeNPC('guard', { x: 11, z: 10.7 }, 'Hello.')] });
    dice.hit = false;
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice');
    const bob = attachPlayer(space, { x: 9.4, z: 10.7 }, 'bob');
    face(space, alice.entityId, GHOST_AT);
    choose(space, alice.entityId, bob.entityId);
    space.handleEngage(true, alice.entityId);
    space.step(0);
    clock.ms += 1000;
    space.step(0);
    expect(energyOf(space, alice.entityId).balanceCurrent).toBe(100);
    expect(energyOf(space, bob.entityId).healthCurrent).toBe(100);
    expect(blowsBy(await collectMessages(bob.outbox), alice.entityId)).toEqual([]);
  });

  describe('beside a second nightmare', () => {
    const TARGET_AT = { x: 9.7, z: 10 };
    /** In reach and in front of a dreamer at `BESIDE_GHOST` facing the target, and nearer to them than the target. */
    const NEARER_AT = { x: 10.35, z: 10.15 };
    const NEARER = 'monster:2';
    const twoGhosts = () => arena({ monsterSpawns: [makeMonsterSpawn(TARGET_AT), { ...makeMonsterSpawn(NEARER_AT), id: 'spawn-2' }] });

    it('swings at the target alone, never at the nearer one standing in front', async () => {
      const { clock, space } = twoGhosts();
      const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { character: STRIKER, inventory: [CUDGEL_IN_HAND] });
      const watcher = attachPlayer(space, { x: 15, z: 15 }, 'watcher');
      face(space, alice.entityId, TARGET_AT);
      engage(space, GHOST, alice.entityId);
      for (let swing = 0; swing < 3; swing += 1) {
        space.step(0);
        clock.ms += 1000;
      }
      const messages = await collectMessages(watcher.outbox);
      expect(blowsBy(messages, alice.entityId).map((blow) => blow.targetId)).toEqual([GHOST, GHOST, GHOST]);
      expect(payloads(messages, 'condition').filter((sent) => sent.entityId === NEARER)).toEqual([]);
    });

    it('swings at nothing while the target stands out of reach, though another stands in reach in front', async () => {
      const { clock, space, dice } = twoGhosts();
      dice.hit = false;
      // In reach of the nearer one, due south of it, and out of the target's reach.
      const alice = attachPlayer(space, { x: NEARER_AT.x, z: NEARER_AT.z + 0.65 }, 'alice');
      face(space, alice.entityId, NEARER_AT);
      engage(space, GHOST, alice.entityId);
      for (let swing = 0; swing < 3; swing += 1) {
        space.step(0);
        clock.ms += 1000;
      }
      expect(energyOf(space, alice.entityId).balanceCurrent).toBe(100);
      expect(blowsBy(await collectMessages(alice.outbox), alice.entityId)).toEqual([]);
    });

    it('keeps Attack on when the target changes to the other nightmare, and swings at that one', async () => {
      const { clock, space, dice } = twoGhosts();
      dice.hit = false;
      const alice = attachPlayer(space, BESIDE_GHOST, 'alice');
      face(space, alice.entityId, NEARER_AT);
      engage(space, GHOST, alice.entityId);
      space.handleTarget(NEARER, alice.entityId);
      space.step(0);
      clock.ms += 1000;
      space.step(0);
      expect(blowsBy(await collectMessages(alice.outbox), alice.entityId).map((blow) => blow.targetId)).toEqual([NEARER, NEARER]);
    });
  });

  it('switches Attack off for a dreamer who cannot mend when the target changes to anything but a nightmare, and keeps it off on changing back', async () => {
    const { clock, space, dice } = arena({ npcs: [makeNPC('guard', { x: 11, z: 10.7 }, 'Hello.')] });
    dice.hit = false;
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice');
    attackGhost(space, alice.entityId);
    space.handleTarget('npc:TestSector/guard', alice.entityId);
    space.handleTarget(GHOST, alice.entityId);
    space.step(0);
    clock.ms += 1000;
    space.step(0);
    expect(energyOf(space, alice.entityId).balanceCurrent).toBe(100);
    expect(blowsBy(await collectMessages(alice.outbox), alice.entityId)).toEqual([]);
  });

  it('switches Attack off once its target is driven off, swinging at none that takes its place', async () => {
    const { clock, space, steps } = arena();
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { character: STRIKER, inventory: [CUDGEL_IN_HAND] });
    attackGhost(space, alice.entityId);
    for (let swing = 0; swing < 3; swing += 1) {
      space.step(0);
      clock.ms += 1000;
    }
    clock.ms += RESPAWN_MS;
    space.step(0);
    steps(60);
    const messages = await collectMessages(alice.outbox);
    expect(entities(messages).at(-1)).toMatchObject({ id: 'monster:2', condition: 'hale' });
    expect(blowsBy(messages, alice.entityId).map((blow) => blow.targetId)).toEqual([GHOST, GHOST, GHOST]);
  });

  it('switches Attack off when the dreamer falls, so once raised they swing no more until they switch it on', async () => {
    const { space, steps } = arena();
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { character: { energy: energy({ healthCurrent: 9 }) } });
    const healer = attachPlayer(space, { x: 10, z: 11.4 }, 'healer', {
      character: { lucidity: lucidity('healer', { touch: 2, 'drawing-back': 1 }) },
      inventory: [MOONSTONE_IN_HAND],
    });
    attackGhost(space, alice.entityId);
    steps(1);
    expect(space.isFallen(alice.entityId)).toBe(true);
    engage(space, alice.entityId, healer.entityId);
    steps(140);
    expect(space.isFallen(alice.entityId)).toBe(false);
    steps(40);
    space.handleEngage(true, alice.entityId);
    steps(1);
    // The swing before she fell, then the one she switched on again for.
    expect(blowsBy(await collectMessages(alice.outbox), alice.entityId)).toHaveLength(2);
  });

  /** A Ghost has 60 health, is grazed by any hit, and is wounded at 45 or less: bare hands take 4 a hit, the cudgel 8. */
  it.each([
    ['bare hands', [], 4],
    ['the cudgel', [CUDGEL_IN_HAND], 2],
  ])('harms by what is in hand: %s', async (_label, inventory, hitsToWound) => {
    const { clock, space } = arena();
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { inventory });
    const before = attachPlayer(space, { x: 15, z: 15 }, 'before');
    const after = attachPlayer(space, { x: 16, z: 16 }, 'after');
    const ghostConditions = async (watcher: { outbox: ConnectionOutbox }) =>
      payloads(await collectMessages(watcher.outbox), 'condition').filter((sent) => sent.entityId === GHOST);
    attackGhost(space, alice.entityId);
    for (let swing = 1; swing < hitsToWound; swing += 1) {
      space.step(0);
      clock.ms += 1000;
    }
    expect(await ghostConditions(before)).toEqual([{ entityId: GHOST, condition: 'grazed' }]);
    space.step(0);
    expect(await ghostConditions(after)).toEqual([
      { entityId: GHOST, condition: 'grazed' },
      { entityId: GHOST, condition: 'wounded' },
    ]);
  });

  it('fades a nightmare at zero, lets it go after the fade time, and refills its spawn after the respawn time', async () => {
    const { clock, space } = arena();
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { character: STRIKER, inventory: [CUDGEL_IN_HAND] });
    attackGhost(space, alice.entityId);
    space.step(0);
    clock.ms += 1000;
    space.step(0);
    clock.ms += 1000;
    space.step(0);
    const fadedAt = clock.ms;
    clock.ms = fadedAt + 999;
    space.step(0.05);
    clock.ms = fadedAt + 1000;
    space.step(0.05);
    clock.ms = fadedAt + RESPAWN_MS - 1;
    space.step(0.05);
    clock.ms = fadedAt + RESPAWN_MS;
    space.step(0.05);
    const messages = await collectMessages(alice.outbox);
    expect(
      payloads(messages, 'condition')
        .filter((sent) => sent.entityId === GHOST)
        .at(-1),
    ).toEqual({ entityId: GHOST, condition: 'fallen' });
    const tags = messages.map((message) =>
      message.tag === 'leave' || (message.tag === 'entity' && message.payload.kind === 'monster') ? message.tag : undefined,
    );
    expect(tags.filter((tag) => tag !== undefined)).toEqual(['entity', 'leave', 'entity']);
    expect(payloads(messages, 'leave')).toEqual([{ entityId: GHOST, leftGame: false }]);
    expect(entities(messages).at(-1)).toMatchObject({ id: 'monster:2', condition: 'hale' });
  });

  it('splits the bounty among the standing dreamers within the share radius, and gives each of them the practice in full', () => {
    const { clock, space } = arena();
    const studying = { lucidity: lucidity('fighter', { strike: 5 }, { study: 'toughening' }) };
    const striker = attachPlayer(space, BESIDE_GHOST, 'striker', { character: studying, inventory: [PURSE, CUDGEL_IN_HAND] });
    const near = attachPlayer(space, { x: 10, z: 15.9 }, 'near', { character: studying, inventory: [PURSE] });
    const far = attachPlayer(space, { x: 10, z: 16.1 }, 'far', { character: studying, inventory: [PURSE] });
    const fallen = attachPlayer(space, { x: 12, z: 10 }, 'fallen', { character: { ...studying, energy: energy({ healthCurrent: 0 }) }, inventory: [PURSE] });
    attackGhost(space, striker.entityId);
    for (let swing = 0; swing < 3; swing += 1) {
      space.step(0);
      clock.ms += 1000;
    }
    const coins = (entityId: string) => space.snapshotForPlayer(entityId)!.inventory.find((row) => row.itemId === 'purse')!.quantity;
    const practice = (entityId: string) => characterOf(space, entityId).lucidity.ranks.find((held) => held.teachingId === 'toughening')?.practice;
    expect([striker, near, far, fallen].map((player) => coins(player.entityId))).toEqual([106, 106, 100, 100]);
    expect([striker, near, far, fallen].map((player) => practice(player.entityId))).toEqual([10, 10, undefined, undefined]);
  });

  it('raises the health maximum where a Toughening rank is earned, and recovery then passes the old one', async () => {
    const { clock, space, steps } = arena();
    const almost = lucidity('fighter', {}, { study: 'toughening' });
    almost.ranks.push({ teachingId: 'toughening', rank: 0, practice: 15 });
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { character: STRIKER, inventory: [CUDGEL_IN_HAND] });
    // Within the share radius and out of the Ghost's reach, so nothing takes her health.
    const bob = attachPlayer(space, { x: 10, z: 13 }, 'bob', { character: { lucidity: almost } });
    attackGhost(space, alice.entityId);
    for (let swing = 0; swing < 3; swing += 1) {
      space.step(0);
      clock.ms += 1000;
    }
    expect(characterOf(space, bob.entityId).lucidity.ranks).toContainEqual({ teachingId: 'toughening', rank: 1, practice: 5 });
    expect(energyOf(space, bob.entityId)).toMatchObject({ healthCurrent: 100, healthMax: 110 });
    steps(50);
    expect(energyOf(space, bob.entityId).healthCurrent).toBe(101);
    expect(payloads(await collectMessages(bob.outbox), 'energy').some((sent) => sent.healthMax === 110 && sent.healthCurrent === 100)).toBe(true);
  });
});

describe('a join', () => {
  it('gives the pools the maxima the ranks give, whatever the row held, and no more in them than that', () => {
    const { space } = arena({}, { ghost: false });
    const tough = attachPlayer(space, { x: 5, z: 5 }, 'tough', { character: { lucidity: lucidity('fighter', { strike: 1, toughening: 2 }) } });
    expect(energyOf(space, tough.entityId)).toMatchObject({ healthCurrent: 100, healthMax: 120 });
    const stale = energy({ healthCurrent: 150, healthMax: 150, spiritCurrent: 130, spiritMax: 130 });
    const plain = attachPlayer(space, { x: 6, z: 5 }, 'plain', { character: { energy: stale } });
    expect(energyOf(space, plain.entityId)).toEqual(energy());
  });
});

/** The ghost's ground is its one point, so every dreamer it strikes here stands outside it, within its reach. */
describe('a nightmare striking', () => {
  it('takes health and a little balance, both there in a snapshot taken at once', async () => {
    const { space, steps } = arena();
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice');
    steps(1);
    expect(energyOf(space, alice.entityId)).toMatchObject({ healthCurrent: 91, balanceCurrent: 95 });
    expect(payloads(await collectMessages(alice.outbox), 'blow')).toEqual([{ attackerId: GHOST, targetId: alice.entityId, hit: true }]);
  });

  it('strikes on its own rhythm, and announces a miss without harm', async () => {
    const { space, dice, steps } = arena();
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice');
    dice.hit = false;
    steps(31);
    const blows = payloads(await collectMessages(alice.outbox), 'blow');
    // One at once, the next a second and a half later.
    expect(blows).toEqual([
      { attackerId: GHOST, targetId: alice.entityId, hit: false },
      { attackerId: GHOST, targetId: alice.entityId, hit: false },
    ]);
    expect(energyOf(space, alice.entityId).healthCurrent).toBe(100);
  });

  it('fells a dreamer at zero health: they cannot move, the nightmare lets them be, and others are told only that', async () => {
    const { space, steps } = arena();
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { character: { energy: energy({ healthCurrent: 9 }) } });
    const watcher = attachPlayer(space, { x: 15, z: 15 }, 'watcher');
    steps(1);
    space.flushMoves();
    expect(space.isFallen(alice.entityId)).toBe(true);
    space.handleMove({ x: 10, z: 11, facing: 0, gait: 'jog' }, alice.entityId);
    steps(40);
    space.flushMoves();
    expect(characterOf(space, alice.entityId)).toMatchObject({ position: BESIDE_GHOST, energy: { healthCurrent: 0 } });

    const mine = await collectMessages(alice.outbox);
    // One when they fell, one for the move they then tried.
    expect(payloads(mine, 'correction')).toEqual([BESIDE_GHOST, BESIDE_GHOST]);
    expect(payloads(mine, 'blow')).toHaveLength(1);
    const seen = (await collectMessages(watcher.outbox)).slice(7);
    expect(payloads(seen, 'condition')).toEqual([{ entityId: alice.entityId, condition: 'fallen' }]);
    // She lies due south, the way it already faced, so it neither moved nor turned.
    expect(entityMoves(seen).filter((move) => move.id === GHOST)).toEqual([]);
    expect(seen.map((message) => message.tag)).not.toContain('energy');
  });

  it('keeps a living dreamer at one health or more, and fells them exactly at zero', () => {
    const { clock, space } = makeClockedSpace(
      makeWorld([makeSector('TestSector', { monsterSpawns: [makeMonsterSpawn({ x: 10, z: 10 })] })]),
      OUTDOOR_SPACE_ID,
      {
        random: seededRandom(7),
      },
    );
    clock.ms = RESPAWN_MS;
    space.step(0);
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice');
    let fell = false;
    for (let step = 0; step < 4000 && !fell; step += 1) {
      clock.ms += 50;
      space.step(0.05);
      const health = energyOf(space, alice.entityId).healthCurrent;
      fell = space.isFallen(alice.entityId);
      expect(health === 0).toBe(fell);
      expect(Number.isInteger(health)).toBe(true);
    }
    expect(fell).toBe(true);
  });
});

describe('threat', () => {
  /** A Ghost at `GHOST_AT`, keeping to ground reaching 6 m south and east of it. */
  const withGround = () => arena({ monsterSpawns: [makeMonsterSpawn(GHOST_AT, 6)] });
  /** In the Ghost's reach and its ground, and nearer to it than `BESIDE_GHOST`. */
  const NEARER: Point = { x: 10.6, z: 10.2 };
  const HEALER: Partial<Character> = { lucidity: lucidity('healer', { touch: 2, 'drawing-back': 1, depth: 1 }) };
  const targetsOf = (messages: readonly SomnioMessage[], attackerId: string) =>
    payloads(messages, 'blow').flatMap((blow) => (blow.attackerId === attackerId ? [blow.targetId] : []));

  it('rises less for a Healer mending a Fighter than for the Fighter harming the nightmare, so it strikes the Fighter though the Healer stands nearer', async () => {
    const { space, steps } = withGround();
    // Each landed swing takes 11, and each mend restores 15.
    const fighter = attachPlayer(space, BESIDE_GHOST, 'fighter', {
      character: { lucidity: lucidity('fighter', { strike: 1 }), energy: energy({ healthCurrent: 70 }) },
      inventory: [CUDGEL_IN_HAND],
    });
    const healer = attachPlayer(space, NEARER, 'healer', { character: HEALER, inventory: [MOONSTONE_IN_HAND] });
    attackGhost(space, fighter.entityId);
    engage(space, fighter.entityId, healer.entityId);
    steps(61);
    const messages = await collectMessages(healer.outbox);
    expect(payloads(messages, 'mend')).not.toEqual([]);
    expect(targetsOf(messages, GHOST)).toEqual([fighter.entityId, fighter.entityId, fighter.entityId]);
  });

  it('turns every nightmare the Fighter challenged on them, and one passing a Healer in reach on its way strikes the Fighter once it reaches them', async () => {
    const second = { ...makeMonsterSpawn({ x: 10, z: 14 }, 6), id: 'spawn-2' };
    const { space, steps } = arena({ monsterSpawns: [makeMonsterSpawn({ x: 11, z: 11 }, 6), second] });
    // Out of both nightmares' aggro radius and inside both their grounds, within Challenge's reach of both.
    const fighter = attachPlayer(space, { x: 14, z: 15 }, 'fighter', { character: { lucidity: lucidity('fighter', { strike: 1, guard: 1, challenge: 1 }) } });
    // Within the second's aggro radius, and in its reach as it passes on its way to the Fighter.
    const healer = attachPlayer(space, { x: 11.77, z: 15.16 }, 'healer', { character: HEALER, inventory: [MOONSTONE_IN_HAND] });
    space.handleUseAbility('challenge', fighter.entityId);
    steps(80);
    const messages = await collectMessages(healer.outbox);
    expect(targetsOf(messages, GHOST)).toEqual([fighter.entityId, fighter.entityId]);
    expect(targetsOf(messages, 'monster:2')).toEqual([healer.entityId, fighter.entityId, fighter.entityId]);
  });

  it('forgets a dreamer who fell, so once raised they are struck no sooner than a nearer one', async () => {
    const { space, dice, steps } = withGround();
    const fighter = attachPlayer(space, BESIDE_GHOST, 'fighter', {
      character: { ...STRIKER, energy: energy({ healthCurrent: 9 }) },
      inventory: [CUDGEL_IN_HAND],
    });
    const nearer = attachPlayer(space, NEARER, 'nearer');
    const healer = attachPlayer(space, { x: 10, z: 11.4 }, 'healer', { character: HEALER, inventory: [MOONSTONE_IN_HAND] });
    attackGhost(space, fighter.entityId);
    steps(1);
    // The threat of the Fighter's swing turned it on them rather than on the nearer dreamer.
    expect(space.isFallen(fighter.entityId)).toBe(true);
    dice.hit = false;
    engage(space, fighter.entityId, healer.entityId);
    // The raise, then the grace after it.
    steps(240);
    expect(space.isFallen(fighter.entityId)).toBe(false);
    const watcher = attachPlayer(space, { x: 2, z: 2 }, 'watcher');
    steps(60);
    expect(targetsOf(await collectMessages(watcher.outbox), GHOST)).toEqual([nearer.entityId, nearer.entityId]);
  });

  it('forgets a dreamer who steps outside its ground, so it strikes a nearer one in its reach there instead', async () => {
    const { space, steps } = withGround();
    const fighter = attachPlayer(space, BESIDE_GHOST, 'fighter', { character: { lucidity: lucidity('fighter', { strike: 1 }) }, inventory: [CUDGEL_IN_HAND] });
    // Outside the ground, north-west of the Ghost at its corner, and in its reach.
    const nearer = attachPlayer(space, { x: 9.5, z: 9.6 }, 'nearer');
    attackGhost(space, fighter.entityId);
    steps(1);
    space.handleEngage(false, fighter.entityId);
    // Outside the ground too, still in the Ghost's reach, and further from it than the nearer dreamer.
    space.handleMove({ x: 9.3, z: 10.3, facing: 0, gait: 'walk' }, fighter.entityId);
    steps(40);
    expect(targetsOf(await collectMessages(nearer.outbox), GHOST)).toEqual([fighter.entityId, nearer.entityId]);
  });
});

describe('balance', () => {
  const walkTo = (space: ReturnType<typeof arena>['space'], entityId: string, gait: 'walk' | 'jog' | 'run', stride: number) => {
    let z = 5;
    return () => {
      z += stride;
      space.handleMove({ x: 5, z, facing: 0, gait }, entityId);
    };
  };

  it('drains by the distance run', () => {
    const { space } = arena({}, { ghost: false });
    const alice = attachPlayer(space, { x: 5, z: 5 }, 'alice');
    space.handleMove({ x: 5, z: 6.5, facing: 0, gait: 'run' }, alice.entityId);
    expect(energyOf(space, alice.entityId).balanceCurrent).toBe(95);
    space.handleMove({ x: 5, z: 6.6, facing: 0, gait: 'jog' }, alice.entityId);
    expect(energyOf(space, alice.entityId).balanceCurrent).toBe(95);
  });

  /** 19 steps are 0.95 s: 11.4 standing and 4.56 at a jog, both well clear of a whole number. */
  it.each([
    ['standing', undefined, 61],
    ['at the slow gait', 'walk', 61],
    ['at a jog, at four tenths of the standing rate', 'jog', 54],
    ['at a run, not at all', 'run', 50],
  ] as const)('recovers %s', (_label, gait, expected) => {
    const { space, steps } = arena({}, { ghost: false });
    const alice = attachPlayer(space, { x: 5, z: 5 }, 'alice', { character: { energy: energy({ balanceCurrent: 50 }) } });
    // A stride too short for the running drain to take a whole unit over the 19 steps.
    steps(19, gait === undefined ? undefined : walkTo(space, alice.entityId, gait, 0.01));
    expect(energyOf(space, alice.entityId).balanceCurrent).toBe(expected);
  });

  it.each([
    [14, 14],
    [15, 26],
  ])('starts a dreamer attached with %i balance winded or not by the threshold: walking leaves them at %i', (balance, expected) => {
    const { space, steps } = arena({}, { ghost: false });
    const alice = attachPlayer(space, { x: 5, z: 5 }, 'alice', { character: { energy: energy({ balanceCurrent: balance }) } });
    steps(19, walkTo(space, alice.entityId, 'walk', 0.01));
    expect(energyOf(space, alice.entityId).balanceCurrent).toBe(expected);
  });

  it.each([
    ['winded', 5, 16],
    ['not winded', 50, 61],
  ])('recovers a %s dreamer who only turns on the spot at the standing rate', (_label, balance, expected) => {
    const { space, steps } = arena({}, { ghost: false });
    const alice = attachPlayer(space, { x: 5, z: 5 }, 'alice', { character: { energy: energy({ balanceCurrent: balance }) } });
    let facing = 0;
    steps(19, () => {
      facing += 10;
      space.handleMove({ x: 5, z: 5, facing, gait: 'run' }, alice.entityId);
    });
    expect(energyOf(space, alice.entityId).balanceCurrent).toBe(expected);
  });

  it.each([
    ['the swing that spends', 8, attackGhost, 1],
    ['the hit that takes', 15, () => {}, 61],
  ] as const)('leaves a dreamer winded by %s the last of their balance, and it then holds while they move', (_label, balance, act, runningSteps) => {
    const { space, dice, steps } = arena();
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { character: { energy: energy({ balanceCurrent: balance }) } });
    act(space, alice.entityId);
    // Running, however short the stride, recovers nothing, so three strikes a second and a half apart take 15 balance to nothing.
    let x = BESIDE_GHOST.x;
    steps(runningSteps, () => {
      x += 0.001;
      space.handleMove({ x, z: BESIDE_GHOST.z, facing: 180, gait: 'run' }, alice.entityId);
    });
    expect(energyOf(space, alice.entityId).balanceCurrent).toBe(0);
    dice.hit = false;
    // Half a second, part of it still inside the moving window: a few units back, well short of the threshold.
    steps(10);
    const standing = energyOf(space, alice.entityId).balanceCurrent;
    steps(19, () => {
      x += 0.001;
      space.handleMove({ x, z: BESIDE_GHOST.z, facing: 0, gait: 'walk' }, alice.entityId);
    });
    expect(standing).toBeGreaterThan(0);
    expect(standing).toBeLessThan(15);
    expect(energyOf(space, alice.entityId).balanceCurrent).toBe(standing);
  });
});

describe('a target', () => {
  it('sends the dreamer who targets an entity its health at once, and no one else', async () => {
    const { clock, space } = arena({ npcs: [makeNPC('guard', { x: 15, z: 15 }, 'Hello.')] });
    const alice = vitalsOutbox(clock);
    const aliceId = attachPlayer(space, BESIDE_GHOST, 'alice', { outbox: alice.outbox }).entityId;
    const bob = attachPlayer(space, { x: 5, z: 5 }, 'bob');
    space.handleTarget(GHOST, aliceId);
    space.handleTarget('npc:TestSector/guard', aliceId);
    expect(alice.sent).toEqual([
      { ms: clock.ms, entityId: GHOST, health: 1 },
      { ms: clock.ms, entityId: 'npc:TestSector/guard', health: 1 },
    ]);
    expect(payloads(await collectMessages(bob.outbox), 'vitals')).toEqual([]);
  });

  it('is chosen by a fallen dreamer too, who is sent its health', () => {
    const { clock, space } = arena();
    const alice = vitalsOutbox(clock);
    const aliceId = attachPlayer(space, BESIDE_GHOST, 'alice', { outbox: alice.outbox, character: { energy: energy({ healthCurrent: 0 }) } }).entityId;
    expect(space.isFallen(aliceId)).toBe(true);
    space.handleTarget(GHOST, aliceId);
    expect(alice.sent).toEqual([{ ms: clock.ms, entityId: GHOST, health: 1 }]);
  });

  it('sends a change in its health, to two decimals, no sooner than a quarter second after the last, and nothing while it holds', () => {
    const { clock, space, steps } = arena();
    const alice = vitalsOutbox(clock);
    const aliceId = attachPlayer(space, BESIDE_GHOST, 'alice', { outbox: alice.outbox, character: STRIKER, inventory: [CUDGEL_IN_HAND] }).entityId;
    const start = clock.ms;
    attackGhost(space, aliceId);
    steps(10);
    expect(alice.sent).toEqual([
      { ms: start, entityId: GHOST, health: 1 },
      { ms: start + 250, entityId: GHOST, health: 0.62 },
    ]);
  });

  it('drops a target that is not in the space, keeping the one they had', () => {
    const { clock, space, steps } = arena();
    const alice = vitalsOutbox(clock);
    const aliceId = attachPlayer(space, BESIDE_GHOST, 'alice', { outbox: alice.outbox, character: STRIKER, inventory: [CUDGEL_IN_HAND] }).entityId;
    space.handleTarget(GHOST, aliceId);
    space.handleTarget('monster:99', aliceId);
    face(space, aliceId, GHOST_AT);
    space.handleEngage(true, aliceId);
    steps(5);
    expect(alice.sent.map(({ entityId, health }) => ({ entityId, health }))).toEqual([
      { entityId: GHOST, health: 1 },
      { entityId: GHOST, health: 0.62 },
    ]);
  });

  /** Their own `energy` already tells them their health. */
  it('takes the dreamer themselves as their target, sends them no vitals of their own, and refuses slot 1 to a Fighter at them', async () => {
    const { clock, space, steps, dice } = arena();
    dice.hit = false;
    const alice = vitalsOutbox(clock);
    const aliceId = attachPlayer(space, BESIDE_GHOST, 'alice', { outbox: alice.outbox, character: STRIKER, inventory: [CUDGEL_IN_HAND] }).entityId;
    face(space, aliceId, GHOST_AT);
    engage(space, aliceId, aliceId);
    steps(5);
    space.handleTarget(GHOST, aliceId);
    steps(1);
    expect(alice.sent.map(({ entityId }) => entityId)).toEqual([GHOST]);
    expect(energyOf(space, aliceId).balanceCurrent).toBe(100);
    expect(payloads(await collectMessages(alice.outbox), 'blow').filter((blow) => blow.attackerId === aliceId)).toEqual([]);
  });

  it('switches Attack off when a dreamer who cannot mend targets themselves', () => {
    const { clock, space, dice } = arena();
    dice.hit = false;
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice');
    attackGhost(space, alice.entityId);
    space.handleTarget(alice.entityId, alice.entityId);
    space.handleTarget(GHOST, alice.entityId);
    space.step(0);
    clock.ms += 1000;
    space.step(0);
    expect(energyOf(space, alice.entityId).balanceCurrent).toBe(100);
  });

  it('sends nothing more once the dreamer clears their target', () => {
    const { clock, space, steps } = arena();
    const alice = vitalsOutbox(clock);
    const aliceId = attachPlayer(space, BESIDE_GHOST, 'alice', { outbox: alice.outbox, character: STRIKER, inventory: [CUDGEL_IN_HAND] }).entityId;
    space.handleTarget(GHOST, aliceId);
    space.handleTarget(undefined, aliceId);
    face(space, aliceId, GHOST_AT);
    space.handleEngage(true, aliceId);
    steps(10);
    expect(alice.sent.map(({ entityId }) => entityId)).toEqual([GHOST]);
  });

  it('sends a Healer the health of the dreamer they mend, their target, and of nothing they targeted before', () => {
    const { clock, space, steps } = arena();
    const healer = vitalsOutbox(clock);
    const healerId = attachPlayer(space, { x: 5, z: 5 }, 'healer', {
      outbox: healer.outbox,
      character: { lucidity: lucidity('healer', { touch: 2 }) },
      inventory: [MOONSTONE_IN_HAND],
    }).entityId;
    const hurt = attachPlayer(space, { x: 5, z: 5.7 }, 'hurt', { character: { energy: energy({ healthCurrent: 50 }) } });
    space.handleTarget(GHOST, healerId);
    engage(space, hurt.entityId, healerId);
    steps(5);
    expect(healer.sent.map(({ entityId, health }) => ({ entityId, health }))).toEqual([
      { entityId: GHOST, health: 1 },
      { entityId: hurt.entityId, health: 0.5 },
      { entityId: hurt.entityId, health: 0.6 },
    ]);
  });
});

describe('slot 1 at a dreamer', () => {
  const HEALER: Partial<Character> = { lucidity: lucidity('healer', { touch: 2, 'drawing-back': 1 }) };
  const HURT: Partial<Character> = { energy: energy({ healthCurrent: 50 }) };

  it.each<[string, Partial<Character>, InventoryRow[]]>([
    ['a Fighter, Moonstone in hand or not', STRIKER, [MOONSTONE_IN_HAND]],
    ['a Healer with the Moonstone put away', HEALER, [{ ...MOONSTONE_IN_HAND, equippedHand: undefined }]],
    ['a Healer with a weapon in hand', HEALER, [CUDGEL_IN_HAND]],
  ])('is refused to %s', (_label, character, inventory) => {
    const { space, steps } = arena({}, { ghost: false });
    const healer = attachPlayer(space, { x: 5, z: 5 }, 'healer', { character, inventory });
    const hurt = attachPlayer(space, { x: 5, z: 6 }, 'hurt', { character: HURT });
    engage(space, hurt.entityId, healer.entityId);
    steps(1);
    expect(energyOf(space, hurt.entityId).healthCurrent).toBe(50);
    expect(energyOf(space, healer.entityId).spiritCurrent).toBe(100);
  });

  const GUARD = makeNPC('guard', { x: 6, z: 5 }, 'Hello.');
  const GUARD_ID = 'npc:TestSector/guard';

  it.each([GHOST, GUARD_ID])('is refused at %s to a Healer with the Moonstone in hand, so it is not on at a dreamer targeted next', async (refusedAt) => {
    const { space, steps } = arena({ npcs: [GUARD] });
    const healer = attachPlayer(space, { x: 5, z: 5 }, 'healer', { character: HEALER, inventory: [MOONSTONE_IN_HAND] });
    const hurt = attachPlayer(space, { x: 5, z: 6 }, 'hurt', { character: HURT });
    engage(space, refusedAt, healer.entityId);
    space.handleTarget(hurt.entityId, healer.entityId);
    steps(1);
    expect(energyOf(space, hurt.entityId).healthCurrent).toBe(50);
    expect(energyOf(space, healer.entityId).spiritCurrent).toBe(100);
    expect(payloads(await collectMessages(healer.outbox), 'mend')).toEqual([]);
  });

  it('is refused at an NPC to a Healer with the Moonstone in hand, and the space steps on', () => {
    const { space, steps } = arena({ npcs: [GUARD] }, { ghost: false });
    const healer = attachPlayer(space, { x: 5, z: 5 }, 'healer', { character: HEALER, inventory: [MOONSTONE_IN_HAND] });
    engage(space, GUARD_ID, healer.entityId);
    expect(() => steps(60)).not.toThrow();
  });

  it.each<[string, (space: SpaceActor, healerId: string) => void, number]>([
    ['stays on from one dreamer to the next', () => {}, 60],
    ['goes off at a nightmare targeted between them, which the Moonstone does not swing at', (space, healerId) => space.handleTarget(GHOST, healerId), 50],
  ])('%s', (_label, between, health) => {
    const { clock, space, steps } = arena();
    const healer = attachPlayer(space, { x: 5, z: 5 }, 'healer', { character: HEALER, inventory: [MOONSTONE_IN_HAND] });
    const bren = attachPlayer(space, { x: 5, z: 6 }, 'bren', { character: { energy: energy({ healthCurrent: 100 }) } });
    const alia = attachPlayer(space, { x: 6, z: 5 }, 'alia', { character: HURT });
    engage(space, bren.entityId, healer.entityId);
    steps(1);
    between(space, healer.entityId);
    steps(1);
    space.handleTarget(alia.entityId, healer.entityId);
    clock.ms += 1000;
    steps(1);
    expect(energyOf(space, alia.entityId).healthCurrent).toBe(health);
  });

  it.each<[string, Partial<Character>]>([
    ['a Healer with a weapon in hand', HEALER],
    ['a Fighter', STRIKER],
  ])('from a nightmare to a dreamer goes off for %s, and stays off on changing back', async (_label, character) => {
    const { clock, space, steps, dice } = arena();
    dice.hit = false;
    const engager = attachPlayer(space, BESIDE_GHOST, 'engager', { character, inventory: [CUDGEL_IN_HAND] });
    const hurt = attachPlayer(space, { x: 10.6, z: 11.2 }, 'hurt', { character: HURT });
    attackGhost(space, engager.entityId);
    steps(1);
    space.handleTarget(hurt.entityId, engager.entityId);
    clock.ms += 1000;
    steps(1);
    expect(energyOf(space, hurt.entityId).healthCurrent).toBe(50);
    space.handleTarget(GHOST, engager.entityId);
    clock.ms += 1000;
    steps(1);
    const swings = payloads(await collectMessages(hurt.outbox), 'blow').filter((blow) => blow.attackerId === engager.entityId);
    // The one swing made at the nightmare before the dreamer was targeted.
    expect(swings).toEqual([{ attackerId: engager.entityId, targetId: GHOST, hit: false }]);
  });

  it('goes off when the target leaves the space, so they are not mended once back and targeted again', () => {
    const { space, steps } = arena({}, { ghost: false });
    const healer = attachPlayer(space, { x: 5, z: 5 }, 'healer', { character: HEALER, inventory: [MOONSTONE_IN_HAND] });
    const hurt = attachPlayer(space, { x: 5, z: 6 }, 'hurt', { character: HURT });
    engage(space, hurt.entityId, healer.entityId);
    space.detach(hurt.entityId, true);
    steps(1);
    space.attach(hurt.character, [], new ConnectionOutbox(4096), 0, 'en');
    space.handleTarget(hurt.entityId, healer.entityId);
    steps(1);
    expect(energyOf(space, hurt.entityId).healthCurrent).toBe(50);
  });

  it('starts off in a new space, as after a door, though the Healer targets the same dreamer there', () => {
    const { space, steps } = arena({}, { ghost: false });
    const healer = attachPlayer(space, { x: 5, z: 5 }, 'healer', { character: HEALER, inventory: [MOONSTONE_IN_HAND] });
    const hurt = attachPlayer(space, { x: 5, z: 6 }, 'hurt', { character: HURT });
    engage(space, hurt.entityId, healer.entityId);
    space.detach(healer.entityId, false);
    space.attach(healer.character, [MOONSTONE_IN_HAND], new ConnectionOutbox(4096), 0, 'en');
    space.handleTarget(hurt.entityId, healer.entityId);
    steps(1);
    expect(energyOf(space, hurt.entityId).healthCurrent).toBe(50);
  });

  it('stays on when the dreamer mended falls, and raises them once the Healer steps into touch', async () => {
    const { space, steps, dice } = arena();
    const fighter = attachPlayer(space, BESIDE_GHOST, 'fighter', { character: { energy: energy({ healthCurrent: 9 }) } });
    const healer = attachPlayer(space, { x: 10, z: 13.8 }, 'healer', { character: HEALER, inventory: [MOONSTONE_IN_HAND] });
    engage(space, fighter.entityId, healer.entityId);
    steps(1);
    expect(space.isFallen(fighter.entityId)).toBe(true);
    dice.hit = false;
    space.handleMove({ x: 10, z: 11.4, facing: 180, gait: 'jog' }, healer.entityId);
    steps(1);
    const raisings = payloads(await collectMessages(fighter.outbox), 'raising');
    expect(raisings.map(({ state, healerIds }) => ({ state, healerIds }))).toEqual([{ state: 'holding', healerIds: [healer.entityId] }]);
  });
});

describe('what a dreamer never does', () => {
  it('harms no dreamer, whoever engages them and whatever they hold', async () => {
    const { space, steps } = arena({}, { ghost: false });
    const victim = attachPlayer(space, { x: 5, z: 5 }, 'victim', { character: { energy: energy({ healthCurrent: 50 }) } });
    const brawler = attachPlayer(space, { x: 5, z: 5.6 }, 'brawler', { character: STRIKER, inventory: [CUDGEL_IN_HAND] });
    const pretender = attachPlayer(space, { x: 5.6, z: 5 }, 'pretender', { inventory: [MOONSTONE_IN_HAND] });
    const before = [victim, pretender].map((player) => energyOf(space, player.entityId));
    engage(space, victim.entityId, brawler.entityId);
    engage(space, victim.entityId, pretender.entityId);
    steps(1);
    expect([victim, pretender].map((player) => energyOf(space, player.entityId))).toEqual(before);
    expect(payloads(await collectMessages(victim.outbox), 'blow')).toEqual([]);
  });

  it('does nothing a fallen dreamer asks for: no Attack, no answer, no Mend', async () => {
    const { space, steps, dice } = arena({ npcs: [makeNPC('guard', { x: 10, z: 12 }, 'Hello, $name.\n---\nMore.')] });
    dice.hit = false;
    const fallen = { energy: energy({ healthCurrent: 0 }), lucidity: lucidity('healer', { touch: 3 }) };
    const alice = attachPlayer(space, { x: 10, z: 10.85 }, 'alice', { character: fallen, inventory: [MOONSTONE_IN_HAND] });
    const hurt = attachPlayer(space, { x: 10.6, z: 10.85 }, 'hurt', { character: { energy: energy({ healthCurrent: 50 }) } });
    engage(space, GHOST, alice.entityId);
    space.handleTalk('npc:TestSector/guard', alice.entityId);
    engage(space, hurt.entityId, alice.entityId);
    space.handleUseItem(MOONSTONE_IN_HAND.slot, alice.entityId);
    steps(1);
    expect(energyOf(space, alice.entityId)).toEqual(fallen.energy);
    expect(energyOf(space, hurt.entityId).healthCurrent).toBe(50);
    const messages = await collectMessages(hurt.outbox);
    // The guard greets whoever is near, and says no more to one who asked while fallen.
    expect(serverSays(messages)).toEqual(['Hello, alice.']);
    expect(payloads(messages, 'blow').filter((blow) => blow.attackerId === alice.entityId)).toEqual([]);
  });
});
