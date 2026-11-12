import { describe, expect, it } from 'vitest';
import { BOSS_MOVES, OUTDOOR_SPACE_ID, TELEGRAPHS, monsterKind } from '@somnio/core';
import type { Character, EliteTraitId, Inventory, ItemInstance, Point, Sector } from '@somnio/core';
import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import type { SomnioMessage } from '@somnio/protocol';
import { plain } from '../../core/test/support/items.ts';
import { ConnectionOutbox } from '../src/connection/outbox.ts';
import type { SpaceActor } from '../src/world/spaceActor.ts';
import { seededRandom } from '../src/world/random.ts';
import {
  BESIDE_GHOST,
  COINS,
  CUDGEL,
  GHOST,
  GHOST_AT,
  MOONSTONE,
  RESPAWN_MS,
  STRIKER,
  WAND,
  arena,
  attackGhost,
  carrying,
  characterOf,
  energy,
  energyOf,
  engage,
  face,
  lucidity,
  payloads,
  wearing,
} from './support/combat.ts';
import { collectMessages, entities, entityMoves, recordingOutbox, serverSays, vitalsOutbox } from './support/frames.ts';
import {
  attachPlayer,
  landsAtCentre,
  makeClockedSpace,
  makeMonsterGround,
  makeMonsterSpawn,
  makeNPC,
  makeSector,
  makeSectorLine,
  makeWorld,
} from './support/sectorFactory.ts';

describe('attacking a nightmare', () => {
  const blowsBy = (messages: readonly SomnioMessage[], attackerId: string) => payloads(messages, 'blow').filter((blow) => blow.attackerId === attackerId);

  it.each([
    ['bare hands', wearing(), 8],
    ['the cudgel', wearing(CUDGEL), 18],
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

  it('does not swing with less balance than the swing costs', async () => {
    const { space, dice } = arena();
    dice.hit = false;
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { character: { energy: energy({ balanceCurrent: 7 }) } });
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
      const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { character: STRIKER, inventory: wearing(CUDGEL) });
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
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { character: STRIKER, inventory: wearing(CUDGEL) });
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
      inventory: wearing(MOONSTONE),
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
    ['bare hands', wearing(), 4],
    ['the cudgel', wearing(CUDGEL), 2],
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
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { character: STRIKER, inventory: wearing(CUDGEL) });
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
    const striker = attachPlayer(space, BESIDE_GHOST, 'striker', { character: studying, inventory: carrying({ coins: COINS, worn: [CUDGEL] }) });
    const near = attachPlayer(space, { x: 10, z: 15.9 }, 'near', { character: studying, inventory: carrying({ coins: COINS }) });
    const far = attachPlayer(space, { x: 10, z: 16.1 }, 'far', { character: studying, inventory: carrying({ coins: COINS }) });
    const fallen = attachPlayer(space, { x: 12, z: 10 }, 'fallen', {
      character: { ...studying, energy: energy({ healthCurrent: 0 }) },
      inventory: carrying({ coins: COINS }),
    });
    attackGhost(space, striker.entityId);
    for (let swing = 0; swing < 3; swing += 1) {
      space.step(0);
      clock.ms += 1000;
    }
    const coins = (entityId: string) => space.snapshotForPlayer(entityId)!.inventory.coins;
    const practice = (entityId: string) => characterOf(space, entityId).lucidity.ranks.find((held) => held.teachingId === 'toughening')?.practice;
    expect([striker, near, far, fallen].map((player) => coins(player.entityId))).toEqual([106, 106, 100, 100]);
    expect([striker, near, far, fallen].map((player) => practice(player.entityId))).toEqual([10, 10, undefined, undefined]);
  });

  it('raises the health maximum where a Toughening rank is earned, and recovery then passes the old one', async () => {
    const { clock, space, steps } = arena();
    const almost = lucidity('fighter', {}, { study: 'toughening' });
    almost.ranks.push({ teachingId: 'toughening', rank: 0, practice: 15 });
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { character: STRIKER, inventory: wearing(CUDGEL) });
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

describe('what the gear worn adds', () => {
  const SHIELD: ItemInstance = { id: '00000000-0000-7000-8000-000000000011', ...plain('shield') };
  const STOUT_SHIELD: ItemInstance = { ...SHIELD, rarity: 'magic', affixes: [{ affixId: 'health', value: 8 }] };
  const GUARDING_SHIELD: ItemInstance = { ...SHIELD, rarity: 'magic', affixes: [{ affixId: 'guard', value: 3 }] };
  const AMULET: ItemInstance = {
    id: '00000000-0000-7000-8000-000000000012',
    ...plain('amulet'),
    rarity: 'magic',
    affixes: [
      { affixId: 'balance-recovery', value: 15 },
      { affixId: 'spirit-recovery', value: 15 },
    ],
  };

  it('settles the pool maxima as an item that adds to one is put away and worn again, with no more in a pool than its maximum', async () => {
    const { space } = arena({}, { ghost: false });
    const alice = attachPlayer(space, { x: 5, z: 5 }, 'alice', {
      character: { energy: energy({ healthCurrent: 108, healthMax: 108 }) },
      inventory: wearing(STOUT_SHIELD),
    });
    space.handleUnequip('offHand', alice.entityId);
    space.handleEquip(STOUT_SHIELD.id, undefined, alice.entityId);
    const health = payloads(await collectMessages(alice.outbox), 'energy').map(({ healthCurrent, healthMax }) => [healthCurrent, healthMax]);
    expect(health).toEqual([
      [108, 108],
      [100, 100],
      [100, 108],
    ]);
  });

  /** 39 steps are 1.95 s: 23.4 balance and 1.95 spirit at the base rates, and 26.91 and 2.24 at 15% more. */
  it.each([
    ['nothing', wearing(), 73, 51],
    ['an amulet that hastens both', wearing(AMULET), 76, 52],
  ])('recovers Balance and Spirit by the rates of what is worn: %s', (_label, inventory, balance, spirit) => {
    const { space, steps } = arena({}, { ghost: false });
    const alice = attachPlayer(space, { x: 5, z: 5 }, 'alice', { character: { energy: energy({ balanceCurrent: 50, spiritCurrent: 50 }) }, inventory });
    steps(39);
    expect(energyOf(space, alice.entityId)).toMatchObject({ balanceCurrent: balance, spiritCurrent: spirit });
  });

  /** A roll of 0.55 lands under a Ghost's 0.6 at full balance, and under it less the plain shield's 4 Guard, but not less 7. */
  it.each([
    ['nothing', wearing(), true],
    ['a plain shield', wearing(SHIELD), true],
    ['a shield that rolled Guard', wearing(GUARDING_SHIELD), false],
  ])("lands a Ghost's strike by the Guard worn: %s", async (_label, inventory, hit) => {
    const sector = makeSector('TestSector', { monsterSpawns: [makeMonsterSpawn(GHOST_AT)] });
    const { clock, space } = makeClockedSpace(makeWorld([sector]), OUTDOOR_SPACE_ID, { random: { nextUInt32: () => Math.floor(0.55 * 0x1_0000_0000) } });
    clock.ms = RESPAWN_MS;
    space.step(0);
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { inventory });
    clock.ms += 50;
    space.step(0.05);
    expect(payloads(await collectMessages(alice.outbox), 'blow')).toEqual([{ attackerId: GHOST, targetId: alice.entityId, hit }]);
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
      inventory: wearing(CUDGEL),
    });
    const healer = attachPlayer(space, NEARER, 'healer', { character: HEALER, inventory: wearing(MOONSTONE) });
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
    const healer = attachPlayer(space, { x: 11.77, z: 15.16 }, 'healer', { character: HEALER, inventory: wearing(MOONSTONE) });
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
      inventory: wearing(CUDGEL),
    });
    const nearer = attachPlayer(space, NEARER, 'nearer');
    const healer = attachPlayer(space, { x: 10, z: 11.4 }, 'healer', { character: HEALER, inventory: wearing(MOONSTONE) });
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
    const fighter = attachPlayer(space, BESIDE_GHOST, 'fighter', { character: { lucidity: lucidity('fighter', { strike: 1 }) }, inventory: wearing(CUDGEL) });
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
    const aliceId = attachPlayer(space, BESIDE_GHOST, 'alice', { outbox: alice.outbox, character: STRIKER, inventory: wearing(CUDGEL) }).entityId;
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
    const aliceId = attachPlayer(space, BESIDE_GHOST, 'alice', { outbox: alice.outbox, character: STRIKER, inventory: wearing(CUDGEL) }).entityId;
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
    const aliceId = attachPlayer(space, BESIDE_GHOST, 'alice', { outbox: alice.outbox, character: STRIKER, inventory: wearing(CUDGEL) }).entityId;
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
    const aliceId = attachPlayer(space, BESIDE_GHOST, 'alice', { outbox: alice.outbox, character: STRIKER, inventory: wearing(CUDGEL) }).entityId;
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
      inventory: wearing(MOONSTONE),
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

describe('an elite', () => {
  /** The shares of the Ghost's health a dreamer who targets it is sent while a Fighter swings at it, for `count` steps. */
  function healthUnderSwings(trait: EliteTraitId | undefined, fighter: Partial<Character>, count: number, act: (space: SpaceActor, id: string) => void) {
    const { clock, space, steps } = arena({}, trait === undefined ? {} : { elite: trait });
    const alice = vitalsOutbox(clock);
    const aliceId = attachPlayer(space, BESIDE_GHOST, 'alice', { outbox: alice.outbox, character: fighter, inventory: wearing(CUDGEL) }).entityId;
    face(space, aliceId, GHOST_AT);
    space.handleTarget(GHOST, aliceId);
    act(space, aliceId);
    steps(count);
    return alice.sent.map((vitals) => vitals.health);
  }

  it('carries its rank and its trait on its entity frame, and an ordinary nightmare neither', async () => {
    const elite = arena({}, { elite: 'stony' }).space;
    const ordinary = arena().space;
    const ghostOf = async (space: SpaceActor) =>
      entities(await collectMessages(attachPlayer(space, { x: 5, z: 5 }).outbox)).find((entity) => entity.id === GHOST);
    expect(await ghostOf(elite)).toMatchObject({ name: 'Ghost', rank: 'elite', trait: 'stony' });
    const plainGhost = (await ghostOf(ordinary))!;
    expect('rank' in plainGhost || 'trait' in plainGhost).toBe(false);
  });

  it('shows its trait as an effect without end to a dreamer who targets it', async () => {
    const { space } = arena({}, { elite: 'shielded' });
    const alice = attachPlayer(space, { x: 5, z: 5 });
    space.handleTarget(GHOST, alice.entityId);
    expect(payloads(await collectMessages(alice.outbox), 'effects')).toEqual([{ entityId: GHOST, effects: [{ effectId: 'shielded' }] }]);
  });

  it.each([
    // An ordinary Ghost's 60 health takes the whole 23 of each landed swing.
    ['an ordinary Ghost', undefined, [1, 0.62, 0.23]],
    // Stony takes 0.6 of each, 14, from the elite's 150.
    ['a Stony elite', 'stony', [1, 0.91, 0.81]],
    // The shield takes the first 15 of the first swing, and the second lands whole.
    ['a Shielded elite', 'shielded', [1, 0.95, 0.79]],
  ] as const)("takes slot 1's swings by its trait and its health: %s", (_label, trait, shares) => {
    expect(healthUnderSwings(trait, STRIKER, 30, (space, id) => space.handleEngage(true, id))).toEqual(shares);
  });

  it.each([
    // Cleave's first rank takes 0.6 of a landed cudgel swing, 6.6, taken whole as 7 of 60.
    ['an ordinary Ghost', undefined, [1, 0.88]],
    // Stony takes 0.6 of that again, 4 of 150.
    ['a Stony elite', 'stony', [1, 0.97]],
    // The shield takes all of it, so it lands nothing.
    ['a Shielded elite', 'shielded', [1]],
  ] as const)("takes Cleave's swing by its trait and its health: %s", (_label, trait, shares) => {
    const cleaver = { lucidity: lucidity('fighter', { strike: 1, cleave: 1 }) };
    expect(healthUnderSwings(trait, cleaver, 10, (space, id) => space.handleUseAbility('cleave', id))).toEqual(shares);
  });

  it('grows its shield back 8 s after each blow that breaks it', async () => {
    const { space, steps } = arena({}, { elite: 'shielded' });
    const { outbox, sent } = recordingOutbox();
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { outbox, character: STRIKER, inventory: wearing(CUDGEL) });
    attackGhost(space, alice.entityId);
    space.step(0);
    space.handleEngage(false, alice.entityId);
    steps(159);
    expect(payloads(sent, 'effects')).toEqual([
      { entityId: GHOST, effects: [{ effectId: 'shielded' }] },
      { entityId: GHOST, effects: [] },
    ]);
    const watcher = attachPlayer(space, { x: 5, z: 5 }, 'watcher');
    space.handleTarget(GHOST, watcher.entityId);
    steps(3);
    expect(payloads(await collectMessages(watcher.outbox), 'effects')).toEqual([
      { entityId: GHOST, effects: [] },
      { entityId: GHOST, effects: [{ effectId: 'shielded' }] },
    ]);

    // Broken again, it waits its 8 s again.
    space.handleEngage(true, alice.entityId);
    space.step(0);
    space.handleEngage(false, alice.entityId);
    steps(159);
    expect(payloads(sent, 'effects').slice(2)).toEqual([
      { entityId: GHOST, effects: [{ effectId: 'shielded' }] },
      { entityId: GHOST, effects: [] },
    ]);
    steps(3);
    expect(payloads(sent, 'effects').slice(4)).toEqual([{ entityId: GHOST, effects: [{ effectId: 'shielded' }] }]);
  });

  it("rests back up to its own maximum, more than its kind's", () => {
    const { clock, space, steps } = arena({}, { elite: 'stony' });
    const alice = vitalsOutbox(clock);
    const aliceId = attachPlayer(space, BESIDE_GHOST, 'alice', { outbox: alice.outbox, character: STRIKER, inventory: wearing(CUDGEL) }).entityId;
    attackGhost(space, aliceId);
    steps(30);
    space.handleEngage(false, aliceId);
    space.handleMove({ x: 10, z: 12, facing: 180, gait: 'walk' }, aliceId);
    expect(alice.sent.at(-1)!.health).toBeLessThan(0.9);
    steps(1200);
    expect(alice.sent.at(-1)!.health).toBe(1);
  });

  it('leaves each dreamer who shares it a drop for each of its two rolls', () => {
    const { space, steps } = arena({}, { elite: 'stony', drops: true });
    const { outbox, sent } = recordingOutbox();
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { outbox, character: STRIKER, inventory: wearing(CUDGEL) });
    attackGhost(space, alice.entityId);
    steps(240);
    expect(payloads(sent, 'loot').map((loot) => loot.contents)).toEqual([
      { kind: 'item', baseId: 'dagger', rarity: 'plain' },
      { kind: 'item', baseId: 'dagger', rarity: 'plain' },
    ]);
  });
});

describe('the Necromancer', () => {
  const BOSS = 'monster:1';
  const LAIR_AT: Point = { x: 10, z: 10 };
  /** In the Necromancer's reach, south of it. */
  const BESIDE_BOSS: Point = { x: 10, z: 10.7 };
  /** Outside the chamber, where the Necromancer chases no one, and within the share radius of the minions it calls up west of it. */
  const OUTSIDE: Point = { x: 3.8, z: 10 };
  /** Outside the chamber too, beside the watcher, where a dreamer it chased steps out to. */
  const STEPPED_OUT: Point = { x: 3.5, z: 11 };
  /** A Fighter whose every landed cudgel swing takes 23, with 150 health, enough to take three wails. */
  const TOUGH: Partial<Character> = { lucidity: lucidity('fighter', { strike: 5, toughening: 5 }), energy: energy({ healthCurrent: 150, healthMax: 150 }) };
  const STEP_MS = 50;
  /** The steps it takes the Necromancer to give its fight up once it has no one to chase. */
  const GIVE_UP_STEPS = (BOSS_MOVES.necromancer.giveUpSeconds * 1000) / STEP_MS;

  /**
   * A Necromancer standing at `LAIR_AT`, whose chamber reaches 6 m each way, on a clock the test
   * advances in 50 ms steps. Once it stands, every roll falls between `odds.low` and `odds.high`,
   * which a test may move: from 0.7 no strike of a nightmare lands, below 0.75 every swing of a
   * dreamer does, and minions are called up west of it. The wail rolls nothing. With `line`, the
   * chamber lies in the west of three sectors in a line.
   */
  function lair(options: { high?: number; line?: boolean; drops?: boolean } = {}) {
    const spawn = { ...makeMonsterGround(LAIR_AT, 6), kind: 'necromancer' as const };
    const sectors: Sector[] = options.line === true ? makeSectorLine({ west: { monsterSpawns: [spawn] } }) : [makeSector('Lair', { monsterSpawns: [spawn] })];
    const placing = landsAtCentre(6);
    const rolls = seededRandom(7);
    const odds = { low: 0.7, high: options.high ?? 1 };
    let standing = false;
    const roll = (): number => Math.floor((odds.low + ((odds.high - odds.low) * rolls.nextUInt32()) / 0x1_0000_0000) * 0x1_0000_0000);
    const { clock, space } = makeClockedSpace(makeWorld(sectors), OUTDOOR_SPACE_ID, {
      random: { nextUInt32: () => (standing ? roll() : placing.nextUInt32()) },
      ...(options.drops === true ? { lootRandom: { nextUInt32: () => 0 } } : {}),
    });
    // A spawn first fills a minute after its space starts, however long its kind's respawn.
    clock.ms = 60_000;
    space.step(0);
    standing = true;
    const steps = (count: number): void => {
      for (let index = 0; index < count; index += 1) {
        clock.ms += STEP_MS;
        space.step(STEP_MS / 1000);
      }
    };
    return { clock, space, steps, odds };
  }

  /** Steps until the Necromancer has begun its first wail, 4 s into the fight. */
  const untilWail = (steps: (count: number) => void) => steps(80);

  const minionsIn = (messages: readonly SomnioMessage[]) => entities(messages).filter((entity) => entity.summonedBy === BOSS);

  /** Ways for Carol, in the east of three sectors in a line, to come into view of the chamber in the west. Each gives the outbox that then hears of it, or none for Carol's own. */
  const COMING_INTO_VIEW = [
    ['joining the space', (space: SpaceActor) => attachPlayer(space, { x: 30, z: 10 }, 'dana').outbox],
    [
      'stepping into a sector that sees it',
      (space: SpaceActor, carol: { entityId: string }) => {
        space.handleMove({ x: 39.5, z: 10, facing: 270, gait: 'run' }, carol.entityId);
        return undefined;
      },
    ],
  ] as const;

  /** Six Fighters round the Necromancer in its reach, each swinging at it, who drive it off within its first wail when every swing lands. */
  const ringOfStrikers = (space: SpaceActor) =>
    Array.from({ length: 6 }, (_, index) => {
      const radians = (index * Math.PI) / 3;
      const at = { x: LAIR_AT.x + 0.7 * Math.sin(radians), z: LAIR_AT.z + 0.7 * Math.cos(radians) };
      const striker = recordingOutbox();
      const { entityId } = attachPlayer(space, at, `striker-${index}`, { outbox: striker.outbox, character: TOUGH, inventory: wearing(CUDGEL) });
      face(space, entityId, LAIR_AT);
      engage(space, BOSS, entityId);
      return { entityId, sent: striker.sent };
    });

  it('stands as a boss, carrying its rank and no trait', async () => {
    const { space } = lair();
    const boss = entities(await collectMessages(attachPlayer(space, OUTSIDE).outbox)).find((entity) => entity.id === BOSS)!;
    expect(boss).toMatchObject({ name: 'Necromancer', rank: 'boss' });
    expect('trait' in boss).toBe(false);
  });

  it('telegraphs its wail round where it stands to everyone who sees it, and strikes only the dreamers still inside as it ends', () => {
    const { space, steps } = lair();
    const alice = attachPlayer(space, BESIDE_BOSS, 'alice', { character: TOUGH });
    const bob = attachPlayer(space, { x: 10, z: 7 }, 'bob', { character: TOUGH });
    const watcher = recordingOutbox();
    attachPlayer(space, OUTSIDE, 'watcher', { outbox: watcher.outbox });
    untilWail(steps);
    expect(payloads(watcher.sent, 'telegraph')).toEqual([{ id: 'telegraph-1', casterId: BOSS, kind: 'wail', x: 10, z: 10, radius: 4, seconds: 2.5 }]);
    space.handleMove({ x: 10, z: 5.5, facing: 180, gait: 'run' }, bob.entityId);
    steps(49);
    const before = [energyOf(space, alice.entityId).healthCurrent, energyOf(space, bob.entityId).healthCurrent];
    steps(1);
    expect([energyOf(space, alice.entityId).healthCurrent, energyOf(space, bob.entityId).healthCurrent]).toEqual([before[0]! - 45, before[1]]);
  });

  it('spares the dreamers in its circle whom nightmares leave alone: the fallen, one in the grace after a raise, and one Veiled', () => {
    const { space, steps } = lair();
    const alice = attachPlayer(space, BESIDE_BOSS, 'alice', { character: TOUGH });
    const fallen = attachPlayer(space, { x: 10, z: 7.5 }, 'fallen', { character: { energy: energy({ healthCurrent: 0 }) } });
    const raised = attachPlayer(space, { x: 13.5, z: 10 }, 'raised', { character: { energy: energy({ healthCurrent: 0 }) } });
    // Outside the circle, within touch of the dreamer it raises.
    const healer = attachPlayer(space, { x: 14.3, z: 10 }, 'healer', {
      character: { lucidity: lucidity('healer', { touch: 2, 'drawing-back': 1 }) },
      inventory: wearing(MOONSTONE),
    });
    // More than a Veil's 5 m from every other dreamer, so it veils the Mystic alone.
    const veiled = attachPlayer(space, { x: 10, z: 15.9 }, 'veiled', { character: { lucidity: lucidity('mystic', { veil: 1 }) }, inventory: wearing(WAND) });
    engage(space, raised.entityId, healer.entityId);
    untilWail(steps);
    space.handleUseAbility('veil', veiled.entityId);
    space.handleMove({ x: 10, z: 13.5, facing: 0, gait: 'walk' }, veiled.entityId);
    steps(49);
    expect(space.isFallen(raised.entityId)).toBe(false);
    space.handleEngage(false, healer.entityId);
    const caught = [alice, fallen, raised, veiled].map((dreamer) => dreamer.entityId);
    const before = caught.map((id) => energyOf(space, id));
    steps(1);
    expect(caught.map((id, index) => before[index]!.healthCurrent - energyOf(space, id).healthCurrent)).toEqual([45, 0, 0, 0]);
    expect(caught.map((id, index) => before[index]!.balanceCurrent - energyOf(space, id).balanceCurrent)).toEqual([15, 0, 0, 0]);
  });

  it('wails only once a dreamer stands in the circle it would strike', () => {
    const { space, steps } = lair();
    const alice = recordingOutbox();
    const aliceId = attachPlayer(space, BESIDE_BOSS, 'alice', { outbox: alice.outbox, character: TOUGH }).entityId;
    steps(79);
    // Inside the chamber and its aggro radius, so it chases her, but more than 4 m from it as its wail falls due.
    space.handleMove({ x: 10, z: 15.5, facing: 0, gait: 'run' }, aliceId);
    steps(1);
    expect(payloads(alice.sent, 'telegraph')).toEqual([]);
    steps(20);
    expect(payloads(alice.sent, 'telegraph')).toHaveLength(1);
  });

  it('fells a dreamer at their last health as a strike does: slot 1 off and a correction, and a Healer raises them after', () => {
    const { space, steps, odds } = lair();
    const { outbox, sent } = recordingOutbox();
    const alice = attachPlayer(space, BESIDE_BOSS, 'alice', { outbox, character: { energy: energy({ healthCurrent: 40 }) } });
    // In the Necromancer's reach as well as in Alice's touch, so it stays where Alice's swing meets it.
    const healer = attachPlayer(space, { x: 10.6, z: 10.4 }, 'healer', {
      character: { lucidity: lucidity('healer', { touch: 2, 'drawing-back': 1 }) },
      inventory: wearing(MOONSTONE),
    });
    face(space, alice.entityId, LAIR_AT);
    engage(space, BOSS, alice.entityId);
    untilWail(steps);
    steps(49);
    // Every strike lands as the wail strikes, so a strike at Alice once she fell would show as a second correction.
    odds.low = 0;
    odds.high = 0.01;
    steps(1);
    odds.low = 0.7;
    odds.high = 1;
    expect(space.isFallen(alice.entityId)).toBe(true);
    const fell = sent.findIndex(
      (message) => message.tag === 'condition' && message.payload.entityId === alice.entityId && message.payload.condition === 'fallen',
    );
    expect(payloads(sent.slice(0, fell), 'blow').some((blow) => blow.attackerId === alice.entityId)).toBe(true);
    expect(payloads(sent.slice(fell), 'correction')).toEqual([{ x: BESIDE_BOSS.x, z: BESIDE_BOSS.z }]);
    engage(space, alice.entityId, healer.entityId);
    steps(140);
    expect(space.isFallen(alice.entityId)).toBe(false);
    steps(40);
    expect(payloads(sent.slice(fell), 'raising').at(-1)).toMatchObject({ targetId: alice.entityId, state: 'done' });
    expect(payloads(sent.slice(fell), 'blow').filter((blow) => blow.attackerId === alice.entityId)).toEqual([]);
  });

  it.each(COMING_INTO_VIEW)('sends a dreamer who comes into view of the wail by %s the seconds it has left', async (_label, comeIntoView) => {
    const { space, steps } = lair({ line: true });
    attachPlayer(space, BESIDE_BOSS, 'alice', { character: TOUGH });
    const carol = attachPlayer(space, { x: 41, z: 10 }, 'carol');
    untilWail(steps);
    steps(20);
    const joined = comeIntoView(space, carol);
    const messages = await collectMessages(joined ?? carol.outbox);
    expect(payloads(messages, 'telegraph')).toEqual([{ id: 'telegraph-1', casterId: BOSS, kind: 'wail', x: 10, z: 10, radius: 4, seconds: 1.5 }]);
  });

  it('calls up two minions at a time round it on its chamber as a fight begins and every 15 s, never more than four standing', () => {
    const { space, steps } = lair();
    attachPlayer(space, BESIDE_BOSS, 'alice', { character: TOUGH });
    const watcher = recordingOutbox();
    attachPlayer(space, OUTSIDE, 'watcher', { outbox: watcher.outbox });
    steps(1);
    expect(minionsIn(watcher.sent)).toHaveLength(2);
    steps(299);
    expect(minionsIn(watcher.sent)).toHaveLength(2);
    steps(1);
    expect(minionsIn(watcher.sent)).toHaveLength(4);
    // Past the third call, which waits out the wail under way as it falls due.
    steps(400);
    const minions = minionsIn(watcher.sent);
    expect(minions).toHaveLength(4);
    for (const minion of minions) {
      expect(minion).toMatchObject({ kind: 'monster', characterModelId: 'skeleton-minion', name: 'Skeleton', condition: 'hale' });
      const away = Math.hypot(minion.x - LAIR_AT.x, minion.z - LAIR_AT.z);
      expect(away >= 1 && away <= 3, `${away}`).toBe(true);
    }
  });

  it("has a minion it calls up wait a strike's time before its first, with a dreamer in its reach and every strike landing", () => {
    const { space, steps, odds } = lair();
    attachPlayer(space, BESIDE_BOSS, 'alice', { character: TOUGH });
    const watcher = recordingOutbox();
    attachPlayer(space, { x: 18, z: 18 }, 'watcher', { outbox: watcher.outbox });
    steps(1);
    const minion = minionsIn(watcher.sent)[0]!;
    attachPlayer(space, { x: minion.x + 0.7, z: minion.z }, 'bob', { character: TOUGH });
    odds.low = 0;
    odds.high = 0.01;
    const blows = () => payloads(watcher.sent, 'blow').filter((blow) => blow.attackerId === minion.id);
    steps((monsterKind('skeleton-minion').strikeSeconds * 1000) / STEP_MS - 1);
    expect(blows()).toEqual([]);
    steps(1);
    expect(blows()).toHaveLength(1);
  });

  /** Whether each entity among `ids` was sent fallen, has left, and left crumbled. */
  const endsOf = (messages: readonly SomnioMessage[], ids: readonly string[]) =>
    ids.map((id) => ({
      fallen: payloads(messages, 'condition').some((sent) => sent.entityId === id && sent.condition === 'fallen'),
      left: payloads(messages, 'leave').some((sent) => sent.entityId === id),
      crumbled: payloads(messages, 'leave').some((sent) => sent.entityId === id && sent.crumbled === true),
    }));
  const STANDING = { fallen: false, left: false, crumbled: false };
  const CRUMBLED = { fallen: false, left: true, crumbled: true };

  it('keeps its minions and the time of its wail when the dreamer it chases steps out of its chamber and back before it gives up', () => {
    const { space, steps } = lair();
    const alice = attachPlayer(space, BESIDE_BOSS, 'alice', { character: TOUGH });
    const watcher = recordingOutbox();
    attachPlayer(space, OUTSIDE, 'watcher', { outbox: watcher.outbox });
    steps(1);
    const minions = minionsIn(watcher.sent).map((minion) => minion.id);
    expect(minions).toHaveLength(2);
    space.handleMove({ ...STEPPED_OUT, facing: 270, gait: 'run' }, alice.entityId);
    steps(GIVE_UP_STEPS - 1);
    space.handleMove({ ...BESIDE_BOSS, facing: 90, gait: 'run' }, alice.entityId);
    // The wail, due 4 s into the fight, begins as Alice is back, however long she stood outside.
    steps(1);
    expect(payloads(watcher.sent, 'telegraph')).toHaveLength(1);
    steps(GIVE_UP_STEPS);
    expect(endsOf(watcher.sent, minions)).toEqual(minions.map(() => STANDING));
  });

  it('holds its first wail back again once it has given its fight up, until 4 s into the next', () => {
    const { space, steps } = lair();
    const alice = attachPlayer(space, BESIDE_BOSS, 'alice', { character: TOUGH });
    const watcher = recordingOutbox();
    attachPlayer(space, OUTSIDE, 'watcher', { outbox: watcher.outbox });
    steps(1);
    space.handleMove({ ...STEPPED_OUT, facing: 270, gait: 'run' }, alice.entityId);
    steps(GIVE_UP_STEPS + 1);
    space.handleMove({ ...BESIDE_BOSS, facing: 90, gait: 'run' }, alice.entityId);
    steps(79);
    expect(payloads(watcher.sent, 'telegraph')).toEqual([]);
    steps(1);
    expect(payloads(watcher.sent, 'telegraph')).toHaveLength(1);
  });

  it('crumbles its minions, paying no one and dropping nothing, once it has had no one to chase for 5 s', () => {
    const { space, steps } = lair({ drops: true });
    const alice = recordingOutbox();
    const aliceId = attachPlayer(space, BESIDE_BOSS, 'alice', { outbox: alice.outbox, character: TOUGH }).entityId;
    const watcher = recordingOutbox();
    attachPlayer(space, OUTSIDE, 'watcher', { outbox: watcher.outbox });
    steps(1);
    const minions = minionsIn(watcher.sent).map((minion) => minion.id);
    expect(minions).toHaveLength(2);
    space.handleMove({ ...STEPPED_OUT, facing: 270, gait: 'run' }, aliceId);
    steps(GIVE_UP_STEPS);
    expect(endsOf(watcher.sent, minions)).toEqual(minions.map(() => STANDING));
    steps(1);
    expect(endsOf(watcher.sent, minions)).toEqual(minions.map(() => CRUMBLED));
    steps(40);
    expect(endsOf(watcher.sent, [BOSS, ...minions])).toEqual([STANDING, ...minions.map(() => CRUMBLED)]);
    for (const sent of [alice.sent, watcher.sent]) {
      expect(payloads(sent, 'inventory').map((inventory) => inventory.coins)).toEqual([0]);
      expect(payloads(sent, 'loot')).toEqual([]);
    }
  });

  it('counts the 5 s before it gives up from when the last dreamer left its chamber, though its wail was under way', () => {
    const { space, steps } = lair();
    const alice = attachPlayer(space, BESIDE_BOSS, 'alice', { character: TOUGH });
    const watcher = recordingOutbox();
    attachPlayer(space, OUTSIDE, 'watcher', { outbox: watcher.outbox });
    untilWail(steps);
    expect(payloads(watcher.sent, 'telegraph')).toHaveLength(1);
    const minions = minionsIn(watcher.sent).map((minion) => minion.id);
    space.handleMove({ ...STEPPED_OUT, facing: 270, gait: 'run' }, alice.entityId);
    steps(GIVE_UP_STEPS);
    expect(endsOf(watcher.sent, minions)).toEqual(minions.map(() => STANDING));
    steps(1);
    expect(endsOf(watcher.sent, minions)).toEqual(minions.map(() => CRUMBLED));
  });

  it('crumbles its minions as it is driven off, and pays only its own bounty', () => {
    const { space, steps } = lair({ high: 0.75 });
    const strikers = ringOfStrikers(space);
    const watcher = recordingOutbox();
    attachPlayer(space, OUTSIDE, 'watcher', { outbox: watcher.outbox });
    for (let step = 0; step < 400 && !endsOf(watcher.sent, [BOSS])[0]!.fallen; step += 1) steps(1);
    const minions = minionsIn(watcher.sent).map((minion) => minion.id);
    expect(minions.length).toBeGreaterThan(0);
    expect(endsOf(watcher.sent, [BOSS, ...minions])).toEqual([{ fallen: true, left: false, crumbled: false }, ...minions.map(() => CRUMBLED)]);
    steps(20);
    // The bounty of 200 split six ways, and nothing for a minion.
    for (const striker of strikers) expect(payloads(striker.sent, 'inventory').at(-1)?.coins).toBe(33);
    expect(payloads(watcher.sent, 'inventory').map((inventory) => inventory.coins)).toEqual([0]);
  });

  it.each(COMING_INTO_VIEW)('sends a dreamer who comes into view of it by %s while it fades no wail it was driven off in', async (_label, comeIntoView) => {
    const { space, steps } = lair({ high: 0.75, line: true });
    const strikers = ringOfStrikers(space);
    const carol = attachPlayer(space, { x: 41, z: 10 }, 'carol');
    const { sent } = strikers[0]!;
    let toldSteps = 0;
    for (let step = 0; step < 400 && !endsOf(sent, [BOSS])[0]!.fallen; step += 1) {
      steps(1);
      if (payloads(sent, 'telegraph').length > 0) toldSteps += 1;
    }
    // Driven off with its first wail told and yet to strike.
    expect(toldSteps).toBeGreaterThan(0);
    expect(toldSteps).toBeLessThan((TELEGRAPHS.wail.seconds * 1000) / STEP_MS);
    steps(5);
    const joined = comeIntoView(space, carol);
    expect(payloads(await collectMessages(joined ?? carol.outbox), 'telegraph')).toEqual([]);
  });

  it('leaves each dreamer who shares it a drop for each of its four rolls', () => {
    const { space, steps } = lair({ high: 0.75, drops: true });
    const strikers = ringOfStrikers(space);
    for (let step = 0; step < 400 && !endsOf(strikers[0]!.sent, [BOSS])[0]!.fallen; step += 1) steps(1);
    for (const striker of strikers) expect(payloads(striker.sent, 'loot')).toHaveLength(4);
  });

  it('pays for a minion driven off as for any nightmare, dropping what its third ring drops, and touches no spawn', () => {
    const { clock, space, steps } = lair({ high: 0.75, drops: true });
    const bob = attachPlayer(space, BESIDE_BOSS, 'bob', { character: TOUGH });
    const watcher = recordingOutbox();
    attachPlayer(space, { x: 18, z: 18 }, 'watcher', { outbox: watcher.outbox });
    steps(1);
    const minion = minionsIn(watcher.sent)[0]!;
    const beside = { x: minion.x + 0.7, z: minion.z };
    const alice = recordingOutbox();
    const aliceId = attachPlayer(space, beside, 'alice', { outbox: alice.outbox, character: TOUGH, inventory: wearing(CUDGEL) }).entityId;
    face(space, aliceId, minion);
    engage(space, minion.id, aliceId);
    for (let step = 0; step < 200 && !endsOf(watcher.sent, [minion.id])[0]!.fallen; step += 1) steps(1);
    expect(endsOf(watcher.sent, [minion.id])[0]!.fallen).toBe(true);
    // Its bounty of 14 split with Bob, who stands within the share radius.
    expect(payloads(alice.sent, 'inventory').at(-1)?.coins).toBe(7);
    const drop = payloads(alice.sent, 'loot')[0]!;
    space.handleMove({ x: drop.x, z: drop.z, facing: 0, gait: 'walk' }, aliceId);
    space.handlePickUp(drop.lootId, aliceId);
    expect(
      payloads(alice.sent, 'inventory')
        .at(-1)
        ?.bag.map((bagged) => bagged.item.tier),
    ).toEqual([3]);
    // The chamber's spawn still holds the Necromancer it showed the watcher on joining, so no other comes however long it waits.
    space.handOver(aliceId, true);
    space.handOver(bob.entityId, true);
    steps(1);
    clock.ms += 3_600_000;
    steps(1);
    expect(entities(watcher.sent).filter((entity) => entity.characterModelId === 'necromancer')).toHaveLength(1);
    expect(endsOf(watcher.sent, [minion.id])).toEqual([{ fallen: true, left: true, crumbled: false }]);
  });
});

describe('slot 1 at a dreamer', () => {
  const HEALER: Partial<Character> = { lucidity: lucidity('healer', { touch: 2, 'drawing-back': 1 }) };
  const HURT: Partial<Character> = { energy: energy({ healthCurrent: 50 }) };

  it.each<[string, Partial<Character>, Inventory]>([
    ['a Fighter, Moonstone in hand or not', STRIKER, wearing(MOONSTONE)],
    ['a Healer with the Moonstone put away', HEALER, carrying({ bag: [MOONSTONE] })],
    ['a Healer with a weapon in hand', HEALER, wearing(CUDGEL)],
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

  it('is refused at an NPC to a Healer with the Moonstone in hand, so it is not on at a dreamer targeted next', async () => {
    const { space, steps } = arena({ npcs: [GUARD] });
    const healer = attachPlayer(space, { x: 5, z: 5 }, 'healer', { character: HEALER, inventory: wearing(MOONSTONE) });
    const hurt = attachPlayer(space, { x: 5, z: 6 }, 'hurt', { character: HURT });
    engage(space, GUARD_ID, healer.entityId);
    space.handleTarget(hurt.entityId, healer.entityId);
    steps(1);
    expect(energyOf(space, hurt.entityId).healthCurrent).toBe(50);
    expect(energyOf(space, healer.entityId).spiritCurrent).toBe(100);
    expect(payloads(await collectMessages(healer.outbox), 'mend')).toEqual([]);
  });

  it('is refused at an NPC to a Healer with the Moonstone in hand, and the space steps on', () => {
    const { space, steps } = arena({ npcs: [GUARD] }, { ghost: false });
    const healer = attachPlayer(space, { x: 5, z: 5 }, 'healer', { character: HEALER, inventory: wearing(MOONSTONE) });
    engage(space, GUARD_ID, healer.entityId);
    expect(() => steps(60)).not.toThrow();
  });

  it.each<[string, (space: SpaceActor, healerId: string) => void, number]>([
    ['stays on from one dreamer to the next', () => {}, 60],
    ['stays on through a nightmare targeted between them, which the empty main hand attacks', (space, healerId) => space.handleTarget(GHOST, healerId), 60],
  ])('%s', (_label, between, health) => {
    const { clock, space, steps } = arena();
    const healer = attachPlayer(space, { x: 5, z: 5 }, 'healer', { character: HEALER, inventory: wearing(MOONSTONE) });
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
    const engager = attachPlayer(space, BESIDE_GHOST, 'engager', { character, inventory: wearing(CUDGEL) });
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
    const healer = attachPlayer(space, { x: 5, z: 5 }, 'healer', { character: HEALER, inventory: wearing(MOONSTONE) });
    const hurt = attachPlayer(space, { x: 5, z: 6 }, 'hurt', { character: HURT });
    engage(space, hurt.entityId, healer.entityId);
    space.handOver(hurt.entityId, true);
    steps(1);
    space.attach(hurt.character, wearing(), new ConnectionOutbox(4096), 0, 'en');
    space.handleTarget(hurt.entityId, healer.entityId);
    steps(1);
    expect(energyOf(space, hurt.entityId).healthCurrent).toBe(50);
  });

  it('starts off in a new space, as after a door, though the Healer targets the same dreamer there', () => {
    const { space, steps } = arena({}, { ghost: false });
    const healer = attachPlayer(space, { x: 5, z: 5 }, 'healer', { character: HEALER, inventory: wearing(MOONSTONE) });
    const hurt = attachPlayer(space, { x: 5, z: 6 }, 'hurt', { character: HURT });
    engage(space, hurt.entityId, healer.entityId);
    space.handOver(healer.entityId, false);
    space.attach(healer.character, wearing(MOONSTONE), new ConnectionOutbox(4096), 0, 'en');
    space.handleTarget(hurt.entityId, healer.entityId);
    steps(1);
    expect(energyOf(space, hurt.entityId).healthCurrent).toBe(50);
  });

  it('stays on when the dreamer mended falls, and raises them once the Healer steps into touch', async () => {
    const { space, steps, dice } = arena();
    const fighter = attachPlayer(space, BESIDE_GHOST, 'fighter', { character: { energy: energy({ healthCurrent: 9 }) } });
    const healer = attachPlayer(space, { x: 10, z: 13.8 }, 'healer', { character: HEALER, inventory: wearing(MOONSTONE) });
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

describe('slot 1 with two hands', () => {
  const HEALER: Partial<Character> = { lucidity: lucidity('healer', { touch: 2 }) };
  const HURT: Partial<Character> = { energy: energy({ healthCurrent: 50 }) };
  const MOONSTONE_PUT_AWAY = carrying({ worn: [CUDGEL], bag: [MOONSTONE] });
  const blowsBy = (messages: readonly SomnioMessage[], attackerId: string) => payloads(messages, 'blow').filter((blow) => blow.attackerId === attackerId);

  it('attacks a nightmare and mends a dreamer, by the target, for a Healer holding a weapon and the Moonstone', async () => {
    const { clock, space, steps, dice } = arena();
    dice.hit = false;
    const healer = attachPlayer(space, BESIDE_GHOST, 'healer', { character: HEALER, inventory: wearing(CUDGEL, MOONSTONE) });
    const hurt = attachPlayer(space, { x: 10.6, z: 11.2 }, 'hurt', { character: HURT });
    attackGhost(space, healer.entityId);
    steps(1);
    space.handleTarget(hurt.entityId, healer.entityId);
    clock.ms += 1000;
    steps(1);
    expect(energyOf(space, hurt.entityId).healthCurrent).toBe(60);
    space.handleTarget(GHOST, healer.entityId);
    clock.ms += 1000;
    steps(1);
    const miss = { attackerId: healer.entityId, targetId: GHOST, hit: false };
    expect(blowsBy(await collectMessages(hurt.outbox), healer.entityId)).toEqual([miss, miss]);
  });

  it('stays on at a nightmare as the Moonstone comes into the off hand and the weapon leaves the main hand', async () => {
    const { clock, space, steps, dice } = arena();
    dice.hit = false;
    const healer = attachPlayer(space, BESIDE_GHOST, 'healer', { character: HEALER, inventory: MOONSTONE_PUT_AWAY });
    attackGhost(space, healer.entityId);
    steps(1);
    space.handleEquip(MOONSTONE.id, undefined, healer.entityId);
    clock.ms += 1000;
    steps(1);
    space.handleUnequip('mainHand', healer.entityId);
    clock.ms += 1000;
    steps(1);
    expect(blowsBy(await collectMessages(healer.outbox), healer.entityId)).toHaveLength(3);
  });

  it('goes off at a dreamer once the Moonstone leaves the off hand, and stays off once it is back', () => {
    const { clock, space, steps } = arena({}, { ghost: false });
    const healer = attachPlayer(space, { x: 5, z: 5 }, 'healer', { character: HEALER, inventory: wearing(MOONSTONE) });
    const hurt = attachPlayer(space, { x: 5, z: 6 }, 'hurt', { character: HURT });
    engage(space, hurt.entityId, healer.entityId);
    steps(1);
    expect(energyOf(space, hurt.entityId).healthCurrent).toBe(60);
    space.handleUnequip('offHand', healer.entityId);
    clock.ms += 1000;
    steps(1);
    space.handleEquip(MOONSTONE.id, undefined, healer.entityId);
    clock.ms += 1000;
    steps(1);
    expect(energyOf(space, hurt.entityId).healthCurrent).toBe(60);
  });
});

describe('wearing and putting away', () => {
  const CAP: ItemInstance = { id: '00000000-0000-7000-8000-000000000021', ...plain('cap') };
  const BUCKLER: ItemInstance = { id: '00000000-0000-7000-8000-000000000022', ...plain('buckler') };
  const fullBag = (): ItemInstance[] =>
    Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxBagItems }, (_, index) => ({
      ...CAP,
      id: `00000000-0000-7000-8000-1${String(index).padStart(11, '0')}`,
    }));
  const inventoryOf = (space: SpaceActor, entityId: string): Inventory => space.snapshotForPlayer(entityId)!.inventory;

  it('wears an item on the head and puts it away again, as it does an item in the hand', async () => {
    const { space } = arena({}, { ghost: false });
    const alice = attachPlayer(space, { x: 5, z: 5 }, 'alice', { inventory: carrying({ bag: [CAP] }) });
    space.handleEquip(CAP.id, undefined, alice.entityId);
    expect(inventoryOf(space, alice.entityId)).toEqual(wearing(CAP));
    space.handleUnequip('head', alice.entityId);
    expect(inventoryOf(space, alice.entityId)).toEqual(carrying({ bag: [CAP] }));
    const sent = payloads(await collectMessages(alice.outbox), 'inventory').slice(1);
    expect(sent.map(({ equipped, bag }) => [equipped.map(({ slot, item }) => [slot, item.id]), bag.map(({ item }) => item.id)])).toEqual([
      [[['head', CAP.id]], []],
      [[], [CAP.id]],
    ]);
  });

  it('wears a ring in the free ring slot, else in the first, and never round the neck', () => {
    const rings = [0, 1, 2].map((index): ItemInstance => ({ id: `00000000-0000-7000-8000-00000000003${index}`, ...plain('ring') }));
    const [first, second, third] = rings as [ItemInstance, ItemInstance, ItemInstance];
    const { space } = arena({}, { ghost: false });
    const alice = attachPlayer(space, { x: 5, z: 5 }, 'alice', { inventory: carrying({ bag: rings }) });
    space.handleEquip(first.id, undefined, alice.entityId);
    space.handleEquip(second.id, undefined, alice.entityId);
    expect(inventoryOf(space, alice.entityId).equipped).toEqual({ ring1: first, ring2: second });
    space.handleEquip(third.id, undefined, alice.entityId);
    expect(inventoryOf(space, alice.entityId)).toEqual({ coins: 0, equipped: { ring1: third, ring2: second }, bag: [{ place: 2, item: first }] });
  });

  it('puts what the slot wore into the bag as another item takes it', () => {
    const { space } = arena({}, { ghost: false });
    const alice = attachPlayer(space, { x: 5, z: 5 }, 'alice', { inventory: carrying({ worn: [MOONSTONE], bag: [BUCKLER] }) });
    space.handleEquip(BUCKLER.id, undefined, alice.entityId);
    expect(inventoryOf(space, alice.entityId)).toEqual(carrying({ worn: [BUCKLER], bag: [MOONSTONE] }));
  });

  it('shows everyone who sees the dreamer what their hands hold, on joining and on each change of a hand', async () => {
    const { space } = arena({}, { ghost: false });
    const alice = attachPlayer(space, { x: 5, z: 5 }, 'alice', { inventory: carrying({ worn: [MOONSTONE], bag: [CUDGEL, CAP] }) });
    const bob = attachPlayer(space, { x: 6, z: 5 }, 'bob');
    space.handleEquip(CUDGEL.id, undefined, alice.entityId);
    space.handleEquip(CAP.id, undefined, alice.entityId);
    space.handleUnequip('offHand', alice.entityId);
    const messages = await collectMessages(bob.outbox);
    expect(entities(messages).find(({ id }) => id === alice.entityId)?.held).toEqual({ offHand: 'moonstone' });
    expect(payloads(messages, 'held')).toEqual([
      { entityId: alice.entityId, held: { mainHand: 'cudgel', offHand: 'moonstone' } },
      { entityId: alice.entityId, held: { mainHand: 'cudgel' } },
    ]);
  });

  it('refuses to put a worn item into a full bag', () => {
    const { space } = arena({}, { ghost: false });
    const full = carrying({ worn: [CAP, BUCKLER], bag: fullBag() });
    const alice = attachPlayer(space, { x: 5, z: 5 }, 'alice', { inventory: full });
    space.handleUnequip('head', alice.entityId);
    space.handleMoveItem(BUCKLER.id, 3, alice.entityId);
    expect(inventoryOf(space, alice.entityId)).toEqual(full);
  });

  it('wears a ring in the ring slot asked for, and moves a worn one to the other', () => {
    const ring: ItemInstance = { id: '00000000-0000-7000-8000-000000000040', ...plain('ring') };
    const { space } = arena({}, { ghost: false });
    const alice = attachPlayer(space, { x: 5, z: 5 }, 'alice', { inventory: carrying({ bag: [ring] }) });
    space.handleEquip(ring.id, 'ring2', alice.entityId);
    expect(inventoryOf(space, alice.entityId).equipped).toEqual({ ring2: ring });
    space.handleEquip(ring.id, 'ring1', alice.entityId);
    space.handleEquip(ring.id, 'neck', alice.entityId);
    expect(inventoryOf(space, alice.entityId).equipped).toEqual({ ring1: ring });
  });

  it('moves a bagged item to the place asked for, swapping with the item there, and answers with the bag at its places', async () => {
    const { space } = arena({}, { ghost: false });
    const alice = attachPlayer(space, { x: 5, z: 5 }, 'alice', { inventory: carrying({ bag: [CAP, BUCKLER] }) });
    space.handleMoveItem(CAP.id, 9, alice.entityId);
    space.handleMoveItem(BUCKLER.id, 9, alice.entityId);
    space.handleMoveItem(BUCKLER.id, 9, alice.entityId);
    space.handleMoveItem(CAP.id, SOMNIO_PROTOCOL_CONSTANTS.maxBagItems, alice.entityId);
    const sent = payloads(await collectMessages(alice.outbox), 'inventory').slice(1);
    expect(sent.map(({ bag }) => bag.map(({ place, item }) => [place, item.id]))).toEqual([
      [
        [1, BUCKLER.id],
        [9, CAP.id],
      ],
      [
        [1, CAP.id],
        [9, BUCKLER.id],
      ],
    ]);
  });

  it('puts a worn item away at the place it is dropped on, or changes it for the item there that fits its slot, even in a full bag', () => {
    const { space } = arena({}, { ghost: false });
    const alice = attachPlayer(space, { x: 5, z: 5 }, 'alice', { inventory: carrying({ worn: [CAP], bag: [BUCKLER] }) });
    space.handleMoveItem(CAP.id, 6, alice.entityId);
    expect(inventoryOf(space, alice.entityId)).toEqual({
      coins: 0,
      equipped: {},
      bag: [
        { place: 0, item: BUCKLER },
        { place: 6, item: CAP },
      ],
    });
    const full = fullBag();
    const bob = attachPlayer(space, { x: 6, z: 5 }, 'bob', {
      inventory: carrying({ worn: [{ ...CAP, id: '00000000-0000-7000-8000-000000000050' }], bag: full }),
    });
    space.handleMoveItem('00000000-0000-7000-8000-000000000050', 4, bob.entityId);
    expect(inventoryOf(space, bob.entityId).equipped.head).toEqual(full[4]);
    expect(inventoryOf(space, bob.entityId).bag[4]).toEqual({ place: 4, item: { ...CAP, id: '00000000-0000-7000-8000-000000000050' } });
  });
});

describe('what a dreamer never does', () => {
  it('harms no dreamer, whoever engages them and whatever they hold', async () => {
    const { space, steps } = arena({}, { ghost: false });
    const victim = attachPlayer(space, { x: 5, z: 5 }, 'victim', { character: { energy: energy({ healthCurrent: 50 }) } });
    const brawler = attachPlayer(space, { x: 5, z: 5.6 }, 'brawler', { character: STRIKER, inventory: wearing(CUDGEL) });
    const pretender = attachPlayer(space, { x: 5.6, z: 5 }, 'pretender', { inventory: wearing(MOONSTONE) });
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
    const alice = attachPlayer(space, { x: 10, z: 10.85 }, 'alice', { character: fallen, inventory: wearing(MOONSTONE) });
    const hurt = attachPlayer(space, { x: 10.6, z: 10.85 }, 'hurt', { character: { energy: energy({ healthCurrent: 50 }) } });
    engage(space, GHOST, alice.entityId);
    space.handleInteract('npc:TestSector/guard', alice.entityId);
    engage(space, hurt.entityId, alice.entityId);
    steps(1);
    expect(energyOf(space, alice.entityId)).toEqual(fallen.energy);
    expect(energyOf(space, hurt.entityId).healthCurrent).toBe(50);
    const messages = await collectMessages(hurt.outbox);
    // The guard greets whoever is near, and says no more to one who asked while fallen.
    expect(serverSays(messages)).toEqual(['Hello, alice.']);
    expect(payloads(messages, 'blow').filter((blow) => blow.attackerId === alice.entityId)).toEqual([]);
  });
});
