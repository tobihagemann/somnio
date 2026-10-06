import { describe, expect, it } from 'vitest';
import { OUTDOOR_SPACE_ID } from '@somnio/core';
import type { InventoryRow } from '@somnio/core';
import { seededRandom } from '../src/world/random.ts';
import {
  BESIDE_GHOST,
  CUDGEL_IN_HAND,
  GHOST,
  MONDSTEIN_IN_HAND,
  RESPAWN_MS,
  STRIKER,
  arena,
  characterOf,
  energy,
  energyOf,
  lucidity,
  payloads,
} from './support/combat.ts';
import { collectMessages, entities, entityMoves, serverSays } from './support/frames.ts';
import { attachPlayer, makeClockedSpace, makeMonsterSpawn, makeNPC, makeSector, makeWorld } from './support/sectorFactory.ts';

const PURSE: InventoryRow = { slot: 0, itemId: 'purse', quantity: 100, equippedHand: undefined };

describe('swinging at a nightmare', () => {
  it('lands one swing per swing interval, each for the balance bare hands cost', async () => {
    const { clock, space } = arena();
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice');
    space.handleSwing(GHOST, alice.entityId);
    space.handleSwing(GHOST, alice.entityId);
    expect(energyOf(space, alice.entityId).balanceCurrent).toBe(92);
    clock.ms += 500;
    space.handleSwing(GHOST, alice.entityId);
    expect(energyOf(space, alice.entityId).balanceCurrent).toBe(92);
    clock.ms += 500;
    space.handleSwing(GHOST, alice.entityId);
    expect(energyOf(space, alice.entityId).balanceCurrent).toBe(84);
    const hit = { attackerId: alice.entityId, targetId: GHOST, hit: true };
    expect(payloads(await collectMessages(alice.outbox), 'blow')).toEqual([hit, hit]);
  });

  /** A client swinging on the rhythm sends a second apart, and its frames arrive a little less or more than a second apart. */
  it('lets a swing in that arrives a little ahead of the rhythm, without bringing the next one forward', () => {
    const { clock, space } = arena();
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice');
    const start = clock.ms;
    const swingAt = (ms: number): number => {
      clock.ms = start + ms;
      space.handleSwing(GHOST, alice.entityId);
      return energyOf(space, alice.entityId).balanceCurrent;
    };
    expect(swingAt(0)).toBe(92);
    expect(swingAt(849)).toBe(92);
    expect(swingAt(950)).toBe(84);
    // The second swing was due at 1000, so the third is due at 2000, not 1950.
    expect(swingAt(1849)).toBe(84);
    expect(swingAt(1850)).toBe(76);
  });

  it('announces a miss and still spends the balance', async () => {
    const { space, dice } = arena();
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice');
    dice.hit = false;
    space.handleSwing(GHOST, alice.entityId);
    expect(energyOf(space, alice.entityId).balanceCurrent).toBe(92);
    const messages = await collectMessages(alice.outbox);
    expect(payloads(messages, 'blow')).toEqual([{ attackerId: alice.entityId, targetId: GHOST, hit: false }]);
    expect(payloads(messages, 'condition')).toEqual([]);
  });

  it.each([
    ['with less balance than the swing costs', { character: { energy: energy({ balanceCurrent: 7 }) } }],
    ['with the Mondstein in hand', { inventory: [MONDSTEIN_IN_HAND] }],
  ])('does not swing %s', async (_label, options) => {
    const { space } = arena();
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', options);
    const before = energyOf(space, alice.entityId);
    space.handleSwing(GHOST, alice.entityId);
    expect(energyOf(space, alice.entityId)).toEqual(before);
    expect(payloads(await collectMessages(alice.outbox), 'blow')).toEqual([]);
  });

  it.each<[string, { x: number; z: number }, string | undefined]>([
    ['at a nightmare out of reach', { x: 10, z: 10.9 }, GHOST],
    ['at nothing', BESIDE_GHOST, undefined],
    ['at a nightmare that is not there', BESIDE_GHOST, 'monster:99'],
  ])('swings at the air %s, for the same balance and the same wait', async (_label, at, targetId) => {
    const { space } = arena();
    const alice = attachPlayer(space, at, 'alice');
    space.handleSwing(targetId, alice.entityId);
    // The wait is the swing's own: one at the nightmare in reach right after it does not happen.
    space.handleSwing(GHOST, alice.entityId);
    expect(energyOf(space, alice.entityId).balanceCurrent).toBe(92);
    const messages = await collectMessages(alice.outbox);
    expect(payloads(messages, 'blow')).toEqual([{ attackerId: alice.entityId, hit: false }]);
    expect(payloads(messages, 'condition')).toEqual([]);
  });

  /** A Gespenst has 60 health and is wounded at 45 or less: bare hands take 4 a hit, the cudgel 8. */
  it.each([
    ['bare hands', [], 8, 4],
    ['the cudgel', [CUDGEL_IN_HAND], 18, 2],
  ])('costs and harms by what is in hand: %s', async (_label, inventory, cost, hitsToWound) => {
    const { clock, space } = arena();
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { inventory });
    const watcher = attachPlayer(space, { x: 15, z: 15 }, 'watcher');
    for (let swing = 1; swing <= hitsToWound; swing += 1) {
      space.handleSwing(GHOST, alice.entityId);
      clock.ms += 1000;
      // The condition is announced by the hit that crosses the band, and by none that stays inside one.
      const announced = payloads(
        await collectMessages(swing === hitsToWound ? watcher.outbox : attachPlayer(space, { x: 16, z: 16 }, `w${swing}`).outbox),
        'condition',
      );
      if (swing === hitsToWound) expect(announced).toEqual([{ entityId: GHOST, condition: 'wounded' }]);
      else expect(announced).toEqual([]);
    }
    expect(energyOf(space, alice.entityId).balanceCurrent).toBe(100 - hitsToWound * cost);
  });

  it('fades a nightmare at zero, lets it go after the fade time, and refills its spawn after the respawn time', async () => {
    const { clock, space } = arena();
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { character: STRIKER, inventory: [CUDGEL_IN_HAND] });
    for (let swing = 0; swing < 3; swing += 1) {
      space.handleSwing(GHOST, alice.entityId);
      clock.ms += 1000;
    }
    const fadedAt = clock.ms - 1000;
    space.handleSwing(GHOST, alice.entityId);
    clock.ms = fadedAt + 999;
    space.step(0.05);
    clock.ms = fadedAt + 1000;
    space.step(0.05);
    clock.ms = fadedAt + RESPAWN_MS - 1;
    space.step(0.05);
    clock.ms = fadedAt + RESPAWN_MS;
    space.step(0.05);
    const messages = await collectMessages(alice.outbox);
    // Three swings meet it and the fourth meets the air: a fading nightmare takes none.
    const swings = payloads(messages, 'blow').filter((blow) => blow.attackerId === alice.entityId);
    expect(swings.map((blow) => blow.targetId)).toEqual([GHOST, GHOST, GHOST, undefined]);
    expect(payloads(messages, 'condition').at(-1)).toEqual({ entityId: GHOST, condition: 'fallen' });
    const tags = messages.map((message) =>
      message.tag === 'leave' || (message.tag === 'entity' && message.payload.kind === 'monster') ? message.tag : undefined,
    );
    expect(tags.filter((tag) => tag !== undefined)).toEqual(['entity', 'leave', 'entity']);
    expect(payloads(messages, 'leave')).toEqual([{ entityId: GHOST, leftGame: false }]);
    expect(entities(messages).at(-1)).toMatchObject({ id: 'monster:2', condition: 'hale' });
  });

  it('splits the bounty among the standing dreamers within the share radius, and gives each of them the practice in full', () => {
    const { clock, space } = arena();
    const studying = { lucidity: lucidity('kaempfer', { strike: 5 }, { study: 'toughening' }) };
    const striker = attachPlayer(space, BESIDE_GHOST, 'striker', { character: studying, inventory: [PURSE, CUDGEL_IN_HAND] });
    const near = attachPlayer(space, { x: 10, z: 15.9 }, 'near', { character: studying, inventory: [PURSE] });
    const far = attachPlayer(space, { x: 10, z: 16.1 }, 'far', { character: studying, inventory: [PURSE] });
    const fallen = attachPlayer(space, { x: 12, z: 10 }, 'fallen', { character: { ...studying, energy: energy({ healthCurrent: 0 }) }, inventory: [PURSE] });
    for (let swing = 0; swing < 3; swing += 1) {
      space.handleSwing(GHOST, striker.entityId);
      clock.ms += 1000;
    }
    const coins = (entityId: string) => space.snapshotForPlayer(entityId)!.inventory.find((row) => row.itemId === 'purse')!.quantity;
    const practice = (entityId: string) => characterOf(space, entityId).lucidity.ranks.find((held) => held.teachingId === 'toughening')?.practice;
    expect([striker, near, far, fallen].map((player) => coins(player.entityId))).toEqual([106, 106, 100, 100]);
    expect([striker, near, far, fallen].map((player) => practice(player.entityId))).toEqual([10, 10, undefined, undefined]);
  });

  it('raises the health maximum where a Toughening rank is earned, and recovery then passes the old one', async () => {
    const { clock, space, steps } = arena();
    const almost = lucidity('kaempfer', { strike: 5 }, { study: 'toughening' });
    almost.ranks.push({ teachingId: 'toughening', rank: 0, practice: 15 });
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { character: { lucidity: almost }, inventory: [CUDGEL_IN_HAND] });
    for (let swing = 0; swing < 3; swing += 1) {
      space.handleSwing(GHOST, alice.entityId);
      clock.ms += 1000;
    }
    expect(characterOf(space, alice.entityId).lucidity.ranks).toContainEqual({ teachingId: 'toughening', rank: 1, practice: 5 });
    expect(energyOf(space, alice.entityId)).toMatchObject({ healthCurrent: 100, healthMax: 110 });
    steps(50);
    expect(energyOf(space, alice.entityId).healthCurrent).toBe(101);
    expect(payloads(await collectMessages(alice.outbox), 'energy').some((sent) => sent.healthMax === 110 && sent.healthCurrent === 100)).toBe(true);
  });
});

describe('a join', () => {
  it('gives the pools the maxima the ranks give, whatever the row held, and no more in them than that', () => {
    const { space } = arena({}, { ghost: false });
    const tough = attachPlayer(space, { x: 5, z: 5 }, 'tough', { character: { lucidity: lucidity('kaempfer', { strike: 1, toughening: 2 }) } });
    expect(energyOf(space, tough.entityId)).toMatchObject({ healthCurrent: 100, healthMax: 120 });
    const stale = energy({ healthCurrent: 150, healthMax: 150, spiritCurrent: 130, spiritMax: 130 });
    const plain = attachPlayer(space, { x: 6, z: 5 }, 'plain', { character: { energy: stale } });
    expect(energyOf(space, plain.entityId)).toEqual(energy());
  });
});

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
    const seen = (await collectMessages(watcher.outbox)).slice(6);
    expect(payloads(seen, 'condition')).toEqual([{ entityId: alice.entityId, condition: 'fallen' }]);
    // The nightmare turned to her once, in the step it struck, and never again.
    expect(entityMoves(seen).filter((move) => move.id === GHOST)).toHaveLength(1);
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
    ['the swing that spends', 8, (space: ReturnType<typeof arena>['space'], entityId: string) => space.handleSwing(GHOST, entityId), 0],
    ['the hit that takes', 15, () => {}, 61],
  ] as const)('leaves a dreamer winded by %s the last of their balance, and it then holds while they move', (_label, balance, act, runningSteps) => {
    const { space, dice, steps } = arena();
    const alice = attachPlayer(space, BESIDE_GHOST, 'alice', { character: { energy: energy({ balanceCurrent: balance }) } });
    act(space, alice.entityId);
    // Running, however short the stride, recovers nothing, so three strikes a second and a half apart take 15 balance to nothing.
    let x = BESIDE_GHOST.x;
    steps(runningSteps, () => {
      x += 0.001;
      space.handleMove({ x, z: BESIDE_GHOST.z, facing: 0, gait: 'run' }, alice.entityId);
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

describe('what a dreamer never does', () => {
  it('harms no dreamer, whoever swings or tends and whatever they hold', async () => {
    const { space, steps } = arena({}, { ghost: false });
    const victim = attachPlayer(space, { x: 5, z: 5 }, 'victim', { character: { energy: energy({ healthCurrent: 50 }) } });
    const brawler = attachPlayer(space, { x: 5, z: 5.6 }, 'brawler', { character: STRIKER, inventory: [CUDGEL_IN_HAND] });
    const pretender = attachPlayer(space, { x: 5.6, z: 5 }, 'pretender', { inventory: [MONDSTEIN_IN_HAND] });
    const before = [victim, pretender].map((player) => energyOf(space, player.entityId));
    space.handleSwing(victim.entityId, brawler.entityId);
    space.handleTend(victim.entityId, pretender.entityId);
    space.handleTend(brawler.entityId, brawler.entityId);
    steps(1);
    expect([victim, pretender].map((player) => energyOf(space, player.entityId))).toEqual(before);
    // A swing that names a dreamer meets the air.
    expect(payloads(await collectMessages(victim.outbox), 'blow')).toEqual([{ attackerId: brawler.entityId, hit: false }]);
  });

  it('does nothing a fallen dreamer asks for: no swing, no answer, no mending', async () => {
    const { space, steps, dice } = arena({ npcs: [makeNPC('guard', { x: 10, z: 12 }, 'Hello, $name.\n---\nMore.')] });
    dice.hit = false;
    const fallen = { energy: energy({ healthCurrent: 0 }), lucidity: lucidity('heiler', { touch: 3 }) };
    const alice = attachPlayer(space, { x: 10, z: 10.85 }, 'alice', { character: fallen, inventory: [MONDSTEIN_IN_HAND] });
    const hurt = attachPlayer(space, { x: 10.6, z: 10.85 }, 'hurt', { character: { energy: energy({ healthCurrent: 50 }) } });
    space.handleSwing(GHOST, alice.entityId);
    space.handleTalk('npc:TestSector/guard', alice.entityId);
    space.handleTend(hurt.entityId, alice.entityId);
    space.handleUseItem(MONDSTEIN_IN_HAND.slot, alice.entityId);
    steps(1);
    expect(energyOf(space, alice.entityId)).toEqual(fallen.energy);
    expect(energyOf(space, hurt.entityId).healthCurrent).toBe(50);
    const messages = await collectMessages(hurt.outbox);
    // The guard greets whoever is near, and says no more to one who asked while fallen.
    expect(serverSays(messages)).toEqual(['Hello, alice.']);
    expect(payloads(messages, 'blow').filter((blow) => blow.attackerId === alice.entityId)).toEqual([]);
  });
});
