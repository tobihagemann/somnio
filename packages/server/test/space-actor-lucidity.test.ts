import { describe, expect, it } from 'vitest';
import { NO_LUCIDITY } from '@somnio/core';
import type { Character, InventoryRow, Lucidity, Point, Sector } from '@somnio/core';
import { outdoorSector } from '../../core/test/support/worldFixture.ts';
import {
  BESIDE_GHOST,
  CUDGEL_IN_HAND,
  GHOST,
  MONDSTEIN_IN_HAND,
  RESPAWN_MS,
  arena,
  characterOf,
  energy,
  energyOf,
  lucidity,
  payloads,
} from './support/combat.ts';
import { collectMessages } from './support/frames.ts';
import { attachPlayer, makeNPC } from './support/sectorFactory.ts';

const PUGNAX = 'npc:TestSector/pugnax';
const SANA = 'npc:TestSector/sana';
const LIBUS = 'npc:TestSector/libus';
const AT_PUGNAX: Point = { x: 4, z: 5 };
const AT_SANA: Point = { x: 16, z: 5 };

/** Both masters and an NPC with nothing to offer, round a Gespenst; the Nordwald lies east. */
const TOWN: Partial<Sector> = {
  spawn: { x: 10, z: 18, facing: 0 },
  npcs: [
    { ...makeNPC('pugnax', { x: 4, z: 4 }, ''), service: 'kaempferMaster' },
    { ...makeNPC('sana', { x: 16, z: 4 }, ''), service: 'heilerMaster' },
    makeNPC('libus', { x: 16, z: 17 }, ''),
  ],
};

function town() {
  return arena(TOWN, { sectors: [outdoorSector('Nordwald', { x: 20, z: 0 })] });
}

type Town = ReturnType<typeof town>;

function lucidityOf(space: Town['space'], entityId: string): Lucidity {
  return characterOf(space, entityId).lucidity;
}

/** Puts the player at `to`, however far: a fresh allowance covers a few metres at a time. */
function walk(world: Town, entityId: string, to: Point): void {
  for (let guard = 0; guard < 100; guard += 1) {
    const from = characterOf(world.space, entityId).position;
    const away = Math.hypot(to.x - from.x, to.z - from.z);
    if (away === 0) return;
    const stride = Math.min(1, 5 / away);
    world.clock.ms += 2000;
    world.space.handleMove({ x: from.x + (to.x - from.x) * stride, z: from.z + (to.z - from.z) * stride, facing: 0, gait: 'jog' }, entityId);
  }
  throw new Error(`could not walk to (${to.x}, ${to.z})`);
}

/** Drives the named Gespenst off with three cudgel swings. */
function driveOff(world: Town, entityId: string, ghost: string): void {
  for (let swing = 0; swing < 3; swing += 1) {
    world.space.handleSwing(ghost, entityId);
    world.clock.ms += 1000;
  }
}

describe('a trial', () => {
  it('makes a dreamer who passes and accepts it a Kämpfer for good, studying Strike', async () => {
    const world = town();
    const alice = attachPlayer(world.space, AT_PUGNAX, 'alice', { inventory: [CUDGEL_IN_HAND] });
    world.space.handleAskTask(PUGNAX, undefined, alice.entityId);
    expect(lucidityOf(world.space, alice.entityId).task).toEqual({ role: 'kaempfer', teachingId: undefined, progress: 0 });
    // Completing it early changes nothing.
    world.space.handleCompleteTask(PUGNAX, alice.entityId);
    expect(lucidityOf(world.space, alice.entityId).role).toBeUndefined();

    walk(world, alice.entityId, BESIDE_GHOST);
    // Eight cudgel swings, with the nightmare's own strikes all missing while her balance comes back.
    for (let swing = 0; swing < 8; swing += 1) {
      world.dice.hit = true;
      world.space.handleSwing(GHOST, alice.entityId);
      world.dice.hit = false;
      world.steps(40);
    }
    expect(lucidityOf(world.space, alice.entityId).task?.progress).toBe(1);
    // Passing the trial alone commits nothing, and the other master does not take it.
    expect(lucidityOf(world.space, alice.entityId).role).toBeUndefined();
    walk(world, alice.entityId, AT_SANA);
    world.space.handleCompleteTask(SANA, alice.entityId);
    expect(lucidityOf(world.space, alice.entityId).role).toBeUndefined();

    walk(world, alice.entityId, AT_PUGNAX);
    world.space.handleCompleteTask(PUGNAX, alice.entityId);
    expect(lucidityOf(world.space, alice.entityId)).toEqual({
      role: 'kaempfer',
      ranks: [{ teachingId: 'strike', rank: 1, practice: 0 }],
      study: 'strike',
      task: undefined,
    });
    expect(payloads(await collectMessages(alice.outbox), 'lucidity').at(-1)).toEqual({
      role: 'kaempfer',
      ranks: [{ teachingId: 'strike', rank: 1, practice: 0 }],
      study: 'strike',
    });
  });

  it('makes a Heiler of a dreamer who reaches the Nordwald and returns, and gives them a Mondstein', async () => {
    const world = town();
    const alice = attachPlayer(world.space, AT_SANA, 'alice', { inventory: [{ slot: 0, itemId: 'purse', quantity: 100, equippedHand: undefined }] });
    world.space.handleAskTask(SANA, undefined, alice.entityId);
    walk(world, alice.entityId, { x: 19.5, z: 5 });
    expect(lucidityOf(world.space, alice.entityId).task?.progress).toBe(0);
    walk(world, alice.entityId, { x: 20.5, z: 5 });
    expect(lucidityOf(world.space, alice.entityId).task?.progress).toBe(1);
    walk(world, alice.entityId, AT_SANA);
    world.space.handleCompleteTask(SANA, alice.entityId);
    expect(lucidityOf(world.space, alice.entityId)).toMatchObject({ role: 'heiler', ranks: [{ teachingId: 'touch', rank: 1, practice: 0 }], study: 'touch' });
    const messages = await collectMessages(alice.outbox);
    expect(payloads(messages, 'inventory').at(-1)).toEqual({
      rows: [
        { slot: 0, itemId: 'purse', quantity: 100 },
        { slot: 1, itemId: 'mondstein', quantity: 1 },
      ],
    });
    // The Mondstein follows the role in what the dreamer is sent.
    const order = messages.flatMap((message) => (message.tag === 'inventory' || message.tag === 'lucidity' ? [message.tag] : []));
    expect(order.slice(-2)).toEqual(['lucidity', 'inventory']);
  });

  it("keeps a dreamer holding the Heiler's trial from swinging, until it is completed or given up", () => {
    const world = town();
    const alice = attachPlayer(world.space, AT_SANA, 'alice');
    world.space.handleAskTask(SANA, undefined, alice.entityId);
    walk(world, alice.entityId, BESIDE_GHOST);
    world.dice.hit = false;
    world.space.handleSwing(GHOST, alice.entityId);
    expect(energyOf(world.space, alice.entityId).balanceCurrent).toBe(100);
    world.space.handleAbandonTask(alice.entityId);
    world.space.handleSwing(GHOST, alice.entityId);
    expect(energyOf(world.space, alice.entityId).balanceCurrent).toBe(92);
  });

  it.each<[string, Partial<Character>, string, string | undefined]>([
    ['a dreamer of the other role', { lucidity: lucidity('kaempfer', { strike: 1 }) }, SANA, undefined],
    ['a dreamer who already has the role', { lucidity: lucidity('kaempfer', { strike: 1 }) }, PUGNAX, undefined],
    ['a dreamer who holds a task already', { lucidity: { ...NO_LUCIDITY, task: { role: 'heiler', teachingId: undefined, progress: 0 } } }, PUGNAX, undefined],
    ['a fallen dreamer', { energy: energy({ healthCurrent: 0 }) }, PUGNAX, undefined],
    ['a teaching with no task to it', { lucidity: lucidity('kaempfer', { strike: 1 }) }, PUGNAX, 'guard'],
    ['a teaching whose task was done before', { lucidity: lucidity('kaempfer', { strike: 2, 'follow-through': 2 }) }, PUGNAX, 'follow-through'],
  ])('is not set for %s', (_label, character, master, teachingId) => {
    const world = town();
    const alice = attachPlayer(world.space, master === SANA ? AT_SANA : AT_PUGNAX, 'alice', { character });
    const before = lucidityOf(world.space, alice.entityId);
    world.space.handleAskTask(master, teachingId, alice.entityId);
    expect(lucidityOf(world.space, alice.entityId)).toEqual(before);
  });

  it('is not set from beyond speaking distance, or by an NPC with nothing to offer', () => {
    const world = town();
    const far = attachPlayer(world.space, { x: 4, z: 6.1 }, 'far');
    world.space.handleAskTask(PUGNAX, undefined, far.entityId);
    const reader = attachPlayer(world.space, { x: 16, z: 16 }, 'reader');
    world.space.handleAskTask(LIBUS, undefined, reader.entityId);
    world.space.handleAskTask('npc:TestSector/nobody', undefined, reader.entityId);
    expect([far, reader].map((player) => lucidityOf(world.space, player.entityId).task)).toEqual([undefined, undefined]);
  });
});

describe('practice', () => {
  it('carries the teaching studied to its next ranks, and stops at the last', () => {
    const world = town();
    const almost = lucidity('kaempfer', { strike: 5 }, { study: 'guard' });
    almost.ranks.push({ teachingId: 'guard', rank: 1, practice: 30 });
    const alice = attachPlayer(world.space, BESIDE_GHOST, 'alice', { character: { lucidity: almost }, inventory: [CUDGEL_IN_HAND] });
    driveOff(world, alice.entityId, GHOST);
    // 40 practice at rank 1: 35 for rank 2, and 5 toward rank 3.
    expect(lucidityOf(world.space, alice.entityId)).toMatchObject({
      study: 'guard',
      ranks: [{ teachingId: 'strike' }, { teachingId: 'guard', rank: 2, practice: 5 }],
    });
  });

  it('clears the study once the last rank is reached', () => {
    const world = town();
    const almost = lucidity('kaempfer', { strike: 5 }, { study: 'guard' });
    almost.ranks.push({ teachingId: 'guard', rank: 2, practice: 45 });
    const alice = attachPlayer(world.space, BESIDE_GHOST, 'alice', { character: { lucidity: almost }, inventory: [CUDGEL_IN_HAND] });
    driveOff(world, alice.entityId, GHOST);
    expect(lucidityOf(world.space, alice.entityId)).toMatchObject({
      study: undefined,
      ranks: [{ teachingId: 'strike' }, { teachingId: 'guard', rank: 3, practice: 0 }],
    });
  });

  it('accrues nothing with no teaching studied', () => {
    const world = town();
    const idle = lucidity('kaempfer', { strike: 5 });
    const alice = attachPlayer(world.space, BESIDE_GHOST, 'alice', { character: { lucidity: idle }, inventory: [CUDGEL_IN_HAND] });
    driveOff(world, alice.entityId, GHOST);
    expect(lucidityOf(world.space, alice.entityId)).toEqual(idle);
  });

  it('pays a bounty to a dreamer with no purse by giving them one in the first free slot', () => {
    const world = town();
    const inventory: InventoryRow[] = [
      { ...CUDGEL_IN_HAND, slot: 0 },
      { slot: 2, itemId: 'mondstein', quantity: 1, equippedHand: undefined },
    ];
    const alice = attachPlayer(world.space, BESIDE_GHOST, 'alice', { character: { lucidity: lucidity('kaempfer', { strike: 5 }) }, inventory });
    driveOff(world, alice.entityId, GHOST);
    expect(world.space.snapshotForPlayer(alice.entityId)!.inventory).toContainEqual({ slot: 1, itemId: 'purse', quantity: 12, equippedHand: undefined });
  });
});

describe('studying', () => {
  const kaempfer = (strike: number, overrides: Partial<Lucidity> = {}): Partial<Character> => ({
    lucidity: lucidity('kaempfer', { strike }, { study: 'strike', ...overrides }),
  });

  it("turns to another teaching of the dreamer's role whose needs are met", () => {
    const world = town();
    const alice = attachPlayer(world.space, AT_PUGNAX, 'alice', { character: kaempfer(1) });
    world.space.handleStudy(PUGNAX, 'guard', alice.entityId);
    expect(lucidityOf(world.space, alice.entityId).study).toBe('guard');
    world.space.handleStudy(PUGNAX, 'toughening', alice.entityId);
    expect(lucidityOf(world.space, alice.entityId).study).toBe('toughening');
  });

  it.each<[string, Partial<Character>, string, string]>([
    ['a teaching whose needs are not met', kaempfer(1), PUGNAX, 'follow-through'],
    ['a gated teaching at rank 0', kaempfer(2), PUGNAX, 'follow-through'],
    ['a teaching at its last rank', { lucidity: lucidity('kaempfer', { strike: 5 }, { study: 'guard' }) }, PUGNAX, 'strike'],
    ['a teaching of the other role', kaempfer(1), PUGNAX, 'touch'],
    ['a teaching nobody teaches', kaempfer(1), PUGNAX, 'fireball'],
    ['anything at the other master', kaempfer(1), SANA, 'guard'],
    ['anything for a dreamer with no role', { lucidity: NO_LUCIDITY }, PUGNAX, 'strike'],
  ])('does not turn to %s', (_label, character, master, teachingId) => {
    const world = town();
    const at = master === SANA ? AT_SANA : AT_PUGNAX;
    const alice = attachPlayer(world.space, at, 'alice', { character });
    const before = lucidityOf(world.space, alice.entityId);
    world.space.handleStudy(master, teachingId, alice.entityId);
    expect(lucidityOf(world.space, alice.entityId)).toEqual(before);
  });
});

describe('a gate', () => {
  it('starts a Follow-through count over when the dreamer falls', () => {
    const world = town();
    const tasked = lucidity('kaempfer', { strike: 5 }, { task: { role: 'kaempfer', teachingId: 'follow-through', progress: 2 } });
    const alice = attachPlayer(world.space, BESIDE_GHOST, 'alice', { character: { lucidity: tasked, energy: energy({ healthCurrent: 9 }) } });
    world.steps(1);
    expect(world.space.isFallen(alice.entityId)).toBe(true);
    expect(lucidityOf(world.space, alice.entityId).task).toEqual({ role: 'kaempfer', teachingId: 'follow-through', progress: 0 });
  });

  it('counts each nightmare driven off, and no further than its goal', () => {
    const world = town();
    const tasked = lucidity('kaempfer', { strike: 5 }, { task: { role: 'kaempfer', teachingId: 'follow-through', progress: 2 } });
    const alice = attachPlayer(world.space, BESIDE_GHOST, 'alice', { character: { lucidity: tasked }, inventory: [CUDGEL_IN_HAND] });
    world.dice.hit = true;
    driveOff(world, alice.entityId, GHOST);
    expect(lucidityOf(world.space, alice.entityId).task?.progress).toBe(3);
    world.clock.ms += RESPAWN_MS;
    world.space.step(0);
    driveOff(world, alice.entityId, 'monster:2');
    expect(lucidityOf(world.space, alice.entityId).task?.progress).toBe(3);
    walk(world, alice.entityId, AT_PUGNAX);
    world.space.handleCompleteTask(PUGNAX, alice.entityId);
    expect(lucidityOf(world.space, alice.entityId)).toMatchObject({
      task: undefined,
      study: undefined,
      ranks: [{ teachingId: 'strike' }, { teachingId: 'follow-through', rank: 1, practice: 0 }],
    });
  });

  it('teaches Drawing back from end to end: asked at Touch 2, earned by mending others, and only then does a touch raise', async () => {
    const world = town();
    const novice = attachPlayer(world.space, AT_SANA, 'novice', { character: { lucidity: lucidity('heiler', { touch: 1 }) }, inventory: [MONDSTEIN_IN_HAND] });
    world.space.handleAskTask(SANA, 'drawing-back', novice.entityId);
    expect(lucidityOf(world.space, novice.entityId).task).toBeUndefined();
    world.space.detach(novice.entityId, true);

    const hurt = { energy: energy({ healthCurrent: 20 }), lucidity: lucidity('heiler', { touch: 2, depth: 4 }) };
    const healer = attachPlayer(world.space, AT_SANA, 'healer', { character: hurt, inventory: [MONDSTEIN_IN_HAND] });
    const patient = attachPlayer(world.space, { x: 16.6, z: 5 }, 'patient', { character: { energy: energy({ healthCurrent: 10 }) } });
    const fallen = attachPlayer(world.space, { x: 15.4, z: 5 }, 'fallen', { character: { energy: energy({ healthCurrent: 0 }) } });
    world.space.handleAskTask(SANA, 'drawing-back', healer.entityId);
    expect(lucidityOf(world.space, healer.entityId).task).toEqual({ role: 'heiler', teachingId: 'drawing-back', progress: 0 });
    // A second task is refused while one is held.
    world.space.handleAskTask(SANA, 'drawing-back', healer.entityId);

    // Mending oneself does not count; 30 a touch on another does.
    world.space.handleUseItem(MONDSTEIN_IN_HAND.slot, healer.entityId);
    expect(lucidityOf(world.space, healer.entityId).task?.progress).toBe(0);
    world.clock.ms += 1000;
    world.space.handleTend(patient.entityId, healer.entityId);
    world.steps(1);
    expect(lucidityOf(world.space, healer.entityId).task?.progress).toBe(30);
    world.space.handleCompleteTask(SANA, healer.entityId);
    expect(lucidityOf(world.space, healer.entityId).task?.progress).toBe(30);
    // Tending the fallen dreamer for longer than a touch takes begins nothing before the rank.
    world.space.handleTend(fallen.entityId, healer.entityId);
    world.steps(21);
    world.space.handleTend(patient.entityId, healer.entityId);
    world.steps(1);
    expect(lucidityOf(world.space, healer.entityId).task?.progress).toBe(60);

    world.space.handleCompleteTask(SANA, healer.entityId);
    expect(lucidityOf(world.space, healer.entityId)).toMatchObject({
      task: undefined,
      ranks: expect.arrayContaining([{ teachingId: 'drawing-back', rank: 1, practice: 0 }]),
    });
    world.clock.ms += 1000;
    world.space.handleTend(fallen.entityId, healer.entityId);
    world.steps(1);
    // Only the touch after the rank began a raise.
    expect(payloads(await collectMessages(fallen.outbox), 'raising').map((raising) => raising.state)).toEqual(['begun']);
  });
});

describe('giving up a task', () => {
  it.each([
    ['standing', 100],
    ['fallen', 0],
  ])('clears a task far from any master, %s', (_label, healthCurrent) => {
    const world = town();
    const task = { role: 'kaempfer' as const, teachingId: undefined, progress: 0 };
    const character = { lucidity: { ...NO_LUCIDITY, task }, energy: energy({ healthCurrent }) };
    const alice = attachPlayer(world.space, { x: 10, z: 15 }, 'alice', { character });
    world.space.handleAbandonTask(alice.entityId);
    expect(lucidityOf(world.space, alice.entityId).task).toBeUndefined();
  });
});
