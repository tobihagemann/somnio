import { describe, expect, it } from 'vitest';
import { COMBAT } from '@somnio/core';
import type { Character, Point } from '@somnio/core';
import type { SomnioMessage } from '@somnio/protocol';
import type { PlayerTransient } from '../src/world/spaceActor.ts';
import {
  BESIDE_GHOST,
  CUDGEL_IN_HAND,
  GHOST,
  GHOST_AT,
  MOONSTONE_IN_HAND,
  arena,
  attackGhost,
  characterOf,
  energy,
  energyOf,
  engage,
  lucidity,
  payloads,
  wounded,
} from './support/combat.ts';
import { collectMessages } from './support/frames.ts';
import { attachPlayer, makeMonsterSpawn } from './support/sectorFactory.ts';

/**
 * A Healer who has learned every bar ability at rank 1, and the raise: Deep mend lands 35 after a
 * 1.5 s channel, Renewal heals 2.5 a second for 10 s, Radiance heals 15 round them, and Calm halves
 * their threat.
 */
const HEALER: Partial<Character> = {
  lucidity: lucidity('healer', { touch: 2, depth: 1, 'drawing-back': 1, 'deep-mend': 1, renewal: 1, radiance: 1, calm: 1 }),
};
const ALICE_AT: Point = { x: 5, z: 5 };
/** In Deep mend's and Renewal's range of `ALICE_AT`, and in mend reach of it. */
const BOB_AT: Point = { x: 7, z: 5 };
/** The steps of 50 ms a channel of 1.5 s runs. */
const CHANNEL_STEPS = 30;

type Arena = ReturnType<typeof arena>;

/** A Healer at `ALICE_AT` with the Moonstone in hand, targeting a dreamer at `BOB_AT` of `bobHealth`. */
function healerAndBob({ space }: Arena, bobHealth = 50) {
  const alice = attachPlayer(space, ALICE_AT, 'alice', { character: HEALER, inventory: [MOONSTONE_IN_HAND] });
  const bob = attachPlayer(space, BOB_AT, 'bob', { character: wounded(bobHealth) });
  space.handleTarget(bob.entityId, alice.entityId);
  return { alice, bob };
}

const healthGap = (space: Arena['space'], entityId: string, otherId: string) =>
  energyOf(space, entityId).healthCurrent - energyOf(space, otherId).healthCurrent;

const phases = (messages: readonly SomnioMessage[]) => payloads(messages, 'ability').map(({ phase, seconds }) => [phase, seconds]);

/** The raise under way as a dreamer who joins now is shown it. */
async function raiseNow(space: Arena['space']) {
  const watcher = attachPlayer(space, { x: 6, z: 6 }, 'watcher');
  space.handOver(watcher.entityId, false);
  return payloads(await collectMessages(watcher.outbox), 'raising')[0]!;
}

describe('Deep mend', () => {
  it('channels for its seconds, shown to everyone who sees the Healer, then mends whom it lands on', async () => {
    const field = arena({}, { ghost: false });
    const { space, steps } = field;
    const { alice, bob } = healerAndBob(field);
    space.handleUseAbility('deep-mend', alice.entityId);
    expect(energyOf(space, alice.entityId).spiritCurrent).toBe(82);
    steps(CHANNEL_STEPS - 1);
    expect(energyOf(space, bob.entityId).healthCurrent).toBe(50);
    steps(1);
    expect(energyOf(space, bob.entityId).healthCurrent).toBe(85);
    expect(payloads(await collectMessages(bob.outbox), 'ability')).toEqual([
      { entityId: alice.entityId, abilityId: 'deep-mend', targetId: bob.entityId, phase: 'start', seconds: 1.5 },
      { entityId: alice.entityId, abilityId: 'deep-mend', targetId: bob.entityId, phase: 'done' },
    ]);
  });

  it('lands on the Healer themselves with no dreamer targeted', async () => {
    const field = arena({}, { ghost: false });
    const alice = attachPlayer(field.space, ALICE_AT, 'alice', { character: { ...HEALER, ...wounded(50) }, inventory: [MOONSTONE_IN_HAND] });
    field.space.handleUseAbility('deep-mend', alice.entityId);
    field.steps(CHANNEL_STEPS);
    expect(energyOf(field.space, alice.entityId).healthCurrent).toBe(85);
    expect(phases(await collectMessages(alice.outbox))).toEqual([
      ['start', 1.5],
      ['done', undefined],
    ]);
  });

  it('breaks on a move away from where the Healer stands, mending nothing, and holds through a turn on the spot', async () => {
    const field = arena({}, { ghost: false });
    const { space, steps } = field;
    const { alice, bob } = healerAndBob(field);
    space.handleUseAbility('deep-mend', alice.entityId);
    space.handleMove({ ...ALICE_AT, facing: 90, gait: 'jog' }, alice.entityId);
    steps(CHANNEL_STEPS);
    expect(energyOf(space, bob.entityId).healthCurrent).toBe(85);

    steps(120);
    space.handleUseAbility('deep-mend', alice.entityId);
    space.handleMove({ x: 5, z: 5.05, facing: 90, gait: 'jog' }, alice.entityId);
    steps(CHANNEL_STEPS);
    expect(energyOf(space, bob.entityId).healthCurrent).toBeLessThan(100);
    expect(phases(await collectMessages(bob.outbox))).toEqual([
      ['start', 1.5],
      ['done', undefined],
      ['start', 1.5],
      ['broken', undefined],
    ]);
  });

  it('breaks on a move the server refuses for its length, mending nothing', async () => {
    const field = arena({}, { ghost: false });
    const { alice, bob } = healerAndBob(field);
    field.space.handleUseAbility('deep-mend', alice.entityId);
    field.space.handleMove({ x: 5, z: 18, facing: 0, gait: 'run' }, alice.entityId);
    field.steps(CHANNEL_STEPS);
    expect(characterOf(field.space, alice.entityId).position).toEqual(ALICE_AT);
    expect(energyOf(field.space, bob.entityId).healthCurrent).toBeLessThan(85);
    expect(phases(await collectMessages(bob.outbox))).toEqual([
      ['start', 1.5],
      ['broken', undefined],
    ]);
  });

  it.each([
    ['the dreamer it lands on falls', 'bob'],
    ['the Healer falls', 'alice'],
  ] as const)('breaks the moment %s', async (_label, struck) => {
    const { space, steps } = arena();
    // Whoever stands beside the Ghost is struck down by its first strike; the other stands clear of it, in Deep mend's range.
    const at = (name: string): Point => (name === struck ? BESIDE_GHOST : { x: 5, z: 10 });
    const alice = attachPlayer(space, at('alice'), 'alice', {
      character: { ...HEALER, ...wounded(struck === 'alice' ? 5 : 100) },
      inventory: [MOONSTONE_IN_HAND],
    });
    const bob = attachPlayer(space, at('bob'), 'bob', { character: wounded(5) });
    space.handleTarget(bob.entityId, alice.entityId);
    space.handleUseAbility('deep-mend', alice.entityId);
    steps(1);
    expect(space.isFallen(struck === 'bob' ? bob.entityId : alice.entityId)).toBe(true);
    expect(phases(await collectMessages(alice.outbox))).toEqual([
      ['start', 1.5],
      ['broken', undefined],
    ]);
  });

  it.each([
    ['the Healer leaves', 'alice', 'bob'],
    ['the dreamer it lands on leaves', 'bob', 'alice'],
  ] as const)('breaks the moment %s, shown to the one left', async (_label, leaving, staying) => {
    const field = arena({}, { ghost: false });
    const pair = healerAndBob(field);
    field.space.handleUseAbility('deep-mend', pair.alice.entityId);
    field.space.handOver(pair[leaving].entityId, false);
    expect(phases(await collectMessages(pair[staying].outbox))).toEqual([
      ['start', 1.5],
      ['broken', undefined],
    ]);
  });

  it('holds slot 1 while it runs, and mends with it again in the step the channel lands', async () => {
    const field = arena({}, { ghost: false });
    const { space, steps } = field;
    const { alice, bob } = healerAndBob(field, 20);
    space.handleEngage(true, alice.entityId);
    space.handleUseAbility('deep-mend', alice.entityId);
    steps(CHANNEL_STEPS - 1);
    expect(energyOf(space, bob.entityId).healthCurrent).toBe(20);
    steps(1);
    // Deep mend's 35, and a mend's 15 at the first rank of Depth.
    expect(energyOf(space, bob.entityId).healthCurrent).toBe(70);
    expect(payloads(await collectMessages(bob.outbox), 'mend')).toHaveLength(1);
  });

  it('takes hold of a raise slot 1 is on for only once the channel ends', async () => {
    const field = arena({}, { ghost: false });
    const { space, steps } = field;
    const { alice, bob } = healerAndBob(field);
    // Fallen within the Moonstone's touch.
    const carol = attachPlayer(space, { x: 5, z: 5.7 }, 'carol', { character: wounded(0) });
    space.handleUseAbility('deep-mend', alice.entityId);
    engage(space, carol.entityId, alice.entityId);
    steps(CHANNEL_STEPS - 1);
    expect(payloads(await collectMessages(carol.outbox), 'raising')).toEqual([]);
    const later = attachPlayer(space, { x: 6, z: 6 }, 'later');
    steps(1);
    expect(payloads(await collectMessages(later.outbox), 'raising').map(({ state }) => state)).toEqual(['holding']);
    expect(energyOf(space, bob.entityId).healthCurrent).toBe(85);
  });

  it('holds a raise its Healer already holds on to at its pace while it runs, and adds their pace again once it lands', async () => {
    const field = arena({}, { ghost: false });
    const { space, steps } = field;
    const { alice, bob } = healerAndBob(field);
    // Fallen within the Moonstone's touch.
    const carol = attachPlayer(space, { x: 5, z: 5.7 }, 'carol', { character: wounded(0) });
    engage(space, carol.entityId, alice.entityId);
    steps(1);
    // Within one step, as a client can: Deep mend on Bob, then back to Carol with slot 1 still on.
    space.handleTarget(bob.entityId, alice.entityId);
    space.handleUseAbility('deep-mend', alice.entityId);
    space.handleTarget(carol.entityId, alice.entityId);
    const before = await raiseNow(space);
    expect(before.healerIds).toEqual([alice.entityId]);
    expect(before.pausedSeconds).toEqual([1.5]);
    steps(CHANNEL_STEPS - 1);
    const paused = await raiseNow(space);
    expect(paused.progress).toBe(before.progress);
    expect(paused.seconds).toBeCloseTo(before.seconds - (CHANNEL_STEPS - 1) * 0.05, 9);
    expect(paused.pausedSeconds![0]).toBeCloseTo(0.05, 9);
    steps(1);
    const landed = await raiseNow(space);
    expect(landed.progress).toBe(before.progress);
    expect(landed.pausedSeconds).toBeUndefined();
    expect(energyOf(space, bob.entityId).healthCurrent).toBe(85);
    steps(1);
    expect((await raiseNow(space)).progress).toBeCloseTo(before.progress + 0.05 / COMBAT.raise.seconds, 9);
  });

  it('charges a Healer no raise spirit for the seconds their channel holds their pace back, while the other pays for theirs', () => {
    const field = arena({}, { ghost: false });
    const { space, steps } = field;
    const { alice, bob } = healerAndBob(field);
    const carol = attachPlayer(space, { x: 5, z: 5.7 }, 'carol', { character: wounded(0) });
    const dave = attachPlayer(space, { x: 5.7, z: 5.7 }, 'dave', { character: HEALER, inventory: [MOONSTONE_IN_HAND] });
    engage(space, carol.entityId, alice.entityId);
    engage(space, carol.entityId, dave.entityId);
    steps(2);
    space.handleTarget(bob.entityId, alice.entityId);
    space.handleUseAbility('deep-mend', alice.entityId);
    space.handleTarget(carol.entityId, alice.entityId);
    const spirit = () => [alice, dave].map((one) => energyOf(space, one.entityId).spiritCurrent);
    const [aliceBefore, daveBefore] = spirit();
    steps(CHANNEL_STEPS - 1);
    const [aliceAfter, daveAfter] = spirit();
    // Dave pays for the 1.45 s he paced, and Alice, channelling throughout, only recovers.
    expect(daveBefore! - daveAfter!).toBeGreaterThanOrEqual(Math.floor((COMBAT.raise.spiritCost * 1.4) / COMBAT.raise.seconds));
    expect(aliceAfter).toBeGreaterThanOrEqual(aliceBefore!);
  });

  it('shows a raise one of its two Healers holds on to anew as it starts and as it lands, as far as it has gone then, its seconds counting down to the raise', async () => {
    const field = arena({}, { ghost: false });
    const { clock, space, steps } = field;
    const { alice, bob } = healerAndBob(field);
    // Fallen within the touch of both Healers' Moonstones.
    const carol = attachPlayer(space, { x: 5, z: 5.7 }, 'carol', { character: wounded(0) });
    const dave = attachPlayer(space, { x: 5.7, z: 5.7 }, 'dave', { character: HEALER, inventory: [MOONSTONE_IN_HAND] });
    engage(space, carol.entityId, alice.entityId);
    engage(space, carol.entityId, dave.entityId);
    steps(2);
    const before = await raiseNow(space);
    // Between two steps, as a frame arrives: the channel starts 20 ms after one, so it lands 30 ms before one.
    clock.ms += 20;
    space.handleTarget(bob.entityId, alice.entityId);
    space.handleUseAbility('deep-mend', alice.entityId);
    space.handleTarget(carol.entityId, alice.entityId);
    clock.ms += 30;
    space.step(0.03);
    let took = 0;
    while (space.isFallen(carol.entityId) && took < 200) {
      steps(1);
      took += 1;
    }
    const raisings = payloads(await collectMessages(carol.outbox), 'raising');
    expect(raisings.map(({ state, healerIds }) => [state, healerIds])).toEqual([
      ['holding', [alice.entityId]],
      ['holding', [alice.entityId, dave.entityId]],
      ['holding', [alice.entityId, dave.entityId]],
      ['holding', [alice.entityId, dave.entityId]],
      ['done', [alice.entityId, dave.entityId]],
    ]);
    const [started, landed] = raisings.slice(2);
    // Both for the 20 ms since the last step.
    expect(started!.progress).toBeCloseTo(before.progress + (2 * 0.02) / COMBAT.raise.seconds, 9);
    // Dave alone for the channel's second and a half, then both.
    const left = COMBAT.raise.seconds * (1 - started!.progress);
    expect(started!.seconds).toBeCloseTo(1.5 + (left - 1.5) / 2, 9);
    expect(started!.pausedSeconds).toEqual([1.5, 0]);
    expect(landed!.pausedSeconds).toBeUndefined();
    // Landed in the step 30 ms after its end, as far as the start's schedule reaches by then: no step back, and no jump.
    expect(landed!.progress).toBeCloseTo(started!.progress + (1.5 + 2 * 0.03) / COMBAT.raise.seconds, 9);
    expect(landed!.seconds).toBeCloseTo((COMBAT.raise.seconds * (1 - landed!.progress)) / 2, 9);
    const raisedAfter = 0.03 + took * 0.05;
    expect(raisedAfter).toBeGreaterThanOrEqual(started!.seconds - 1e-9);
    expect(raisedAfter).toBeLessThan(started!.seconds + 0.05);
  });

  it('shows a raise one of its two Healers holds on to anew when their channel breaks, as far as it has gone then, at both paces from then on', async () => {
    const field = arena({}, { ghost: false });
    const { clock, space, steps } = field;
    const { alice, bob } = healerAndBob(field);
    const carol = attachPlayer(space, { x: 5, z: 5.7 }, 'carol', { character: wounded(0) });
    const dave = attachPlayer(space, { x: 5.7, z: 5.7 }, 'dave', { character: HEALER, inventory: [MOONSTONE_IN_HAND] });
    engage(space, carol.entityId, alice.entityId);
    engage(space, carol.entityId, dave.entityId);
    steps(2);
    space.handleTarget(bob.entityId, alice.entityId);
    space.handleUseAbility('deep-mend', alice.entityId);
    space.handleTarget(carol.entityId, alice.entityId);
    steps(10);
    const watcher = attachPlayer(space, { x: 6, z: 6 }, 'watcher');
    // Between two steps, 20 ms after one, a small step breaks the channel, within the touch of Carol.
    clock.ms += 20;
    const breaking = await raiseNow(space);
    space.handleMove({ x: 5, z: 5.05, facing: 90, gait: 'jog' }, alice.entityId);
    const [held, broken, ...rest] = payloads(await collectMessages(watcher.outbox), 'raising');
    expect(held!.pausedSeconds![0]).toBeGreaterThan(0);
    expect(rest).toEqual([]);
    expect([broken!.state, broken!.healerIds]).toEqual(['holding', [alice.entityId, dave.entityId]]);
    // Dave alone for the 20 ms since the step the watcher was shown it in, as one coming into view just before is shown.
    expect(breaking.progress).toBeCloseTo(held!.progress + 0.02 / COMBAT.raise.seconds, 9);
    expect(broken!.progress).toBe(breaking.progress);
    expect(broken!.seconds).toBeCloseTo((COMBAT.raise.seconds * (1 - broken!.progress)) / 2, 9);
    expect(broken!.pausedSeconds).toBeUndefined();
    clock.ms += 30;
    space.step(0.03);
    expect((await raiseNow(space)).progress).toBeCloseTo(broken!.progress + (2 * 0.03) / COMBAT.raise.seconds, 9);
  });

  it('shows a raise done before a channel of one of its Healers ends as due at the pace of the other', async () => {
    const field = arena({}, { ghost: false });
    const { space, steps } = field;
    const { alice, bob } = healerAndBob(field);
    const carol = attachPlayer(space, { x: 5, z: 5.7 }, 'carol', { character: wounded(0) });
    const dave = attachPlayer(space, { x: 5.7, z: 5.7 }, 'dave', { character: HEALER, inventory: [MOONSTONE_IN_HAND] });
    engage(space, carol.entityId, alice.entityId);
    engage(space, carol.entityId, dave.entityId);
    steps(2);
    // On until a second's work is left, which Dave alone finishes within Alice's channel of a second and a half.
    while ((await raiseNow(space)).seconds > 0.5) steps(1);
    const watcher = attachPlayer(space, { x: 6, z: 6 }, 'watcher');
    space.handleTarget(bob.entityId, alice.entityId);
    space.handleUseAbility('deep-mend', alice.entityId);
    space.handleTarget(carol.entityId, alice.entityId);
    const started = payloads(await collectMessages(watcher.outbox), 'raising').at(-1)!;
    const left = COMBAT.raise.seconds * (1 - started.progress);
    expect(left).toBeGreaterThan(0.9);
    expect(left).toBeLessThanOrEqual(1 + 1e-9);
    expect(started.pausedSeconds).toEqual([1.5, 0]);
    expect(started.seconds).toBeCloseTo(left, 9);
  });

  it('refuses every other ability while it runs', async () => {
    const field = arena({}, { ghost: false });
    const { alice } = healerAndBob(field);
    field.space.handleUseAbility('deep-mend', alice.entityId);
    field.clock.ms += 1000;
    field.space.handleUseAbility('renewal', alice.entityId);
    expect(energyOf(field.space, alice.entityId).spiritCurrent).toBe(82);
    expect(phases(await collectMessages(alice.outbox))).toEqual([['start', 1.5]]);
  });

  it('is shown under way, with its seconds left, to a dreamer who targets the Healer while it runs, and to no one else', async () => {
    const field = arena({}, { ghost: false });
    const { alice } = healerAndBob(field);
    const carol = attachPlayer(field.space, { x: 5, z: 7 }, 'carol');
    field.space.handleUseAbility('deep-mend', alice.entityId);
    field.steps(10);
    field.space.handleTarget(alice.entityId, carol.entityId);
    field.space.handleTarget(alice.entityId, carol.entityId);
    expect(phases(await collectMessages(carol.outbox))).toEqual([
      ['start', 1.5],
      ['channel', 1],
    ]);
  });
});

describe('Renewal', () => {
  it("heals whom it lands on its whole health over its seconds, once a second, beside a dreamer's own recovery", async () => {
    const field = arena({}, { ghost: false });
    const { space, steps } = field;
    const { alice, bob } = healerAndBob(field, 40);
    const carol = attachPlayer(space, { x: 5, z: 7 }, 'carol', { character: wounded(40) });
    space.handleUseAbility('renewal', alice.entityId);
    expect(energyOf(space, alice.entityId).spiritCurrent).toBe(85);
    steps(19);
    expect(healthGap(space, bob.entityId, carol.entityId)).toBe(0);
    steps(1);
    expect(healthGap(space, bob.entityId, carol.entityId)).toBe(2);
    steps(200);
    expect(healthGap(space, bob.entityId, carol.entityId)).toBe(25);
    expect(payloads(await collectMessages(bob.outbox), 'effects')).toEqual([
      { entityId: bob.entityId, effects: [{ effectId: 'renewing', seconds: 10 }] },
      { entityId: bob.entityId, effects: [] },
    ]);
  });

  it('gives no more than its whole health in one long step past its end', () => {
    const field = arena({}, { ghost: false });
    const { alice, bob } = healerAndBob(field, 40);
    const carol = attachPlayer(field.space, { x: 5, z: 7 }, 'carol', { character: wounded(40) });
    field.space.handleUseAbility('renewal', alice.entityId);
    field.clock.ms += 12_000;
    field.space.step(12);
    expect(healthGap(field.space, bob.entityId, carol.entityId)).toBe(25);
  });

  it('ends when its holder falls, and heals them no more where they lie', async () => {
    const { space, steps } = arena();
    const alice = attachPlayer(space, { x: 5, z: 10 }, 'alice', { character: HEALER, inventory: [MOONSTONE_IN_HAND] });
    const bob = attachPlayer(space, BESIDE_GHOST, 'bob', { character: wounded(5) });
    space.handleTarget(bob.entityId, alice.entityId);
    space.handleUseAbility('renewal', alice.entityId);
    steps(40);
    expect(space.isFallen(bob.entityId)).toBe(true);
    expect(energyOf(space, bob.entityId).healthCurrent).toBe(0);
    expect(payloads(await collectMessages(bob.outbox), 'effects').at(-1)).toEqual({ entityId: bob.entityId, effects: [] });
  });
});

describe('a heal over time through a door', () => {
  /** A Healer with Renewal at `rank` puts it on a dreamer with another beside them wounded alike, so what Renewal gave is the gap between the two. */
  function renewed(rank: number) {
    const field = arena({}, { ghost: false });
    const alice = attachPlayer(field.space, ALICE_AT, 'alice', {
      character: { lucidity: lucidity('healer', { touch: 2, renewal: rank }) },
      inventory: [MOONSTONE_IN_HAND],
    });
    const bob = attachPlayer(field.space, BOB_AT, 'bob', { character: wounded(40) });
    const carol = attachPlayer(field.space, { x: 9, z: 9 }, 'carol', { character: wounded(40) });
    field.space.handleTarget(bob.entityId, alice.entityId);
    field.space.handleUseAbility('renewal', alice.entityId);
    const given = () => healthGap(field.space, bob.entityId, carol.entityId);
    return { ...field, alice, bob, given };
  }

  /** The dreamer, wounded to 40, arriving in a fresh space with what they carried, beside another wounded alike. */
  function arrive(bob: ReturnType<typeof attachPlayer>, carried: PlayerTransient) {
    const field = arena({}, { ghost: false });
    field.space.attach({ ...bob.character, energy: energy({ healthCurrent: 40 }) }, [], bob.outbox, 0, 'en', carried);
    const carol = attachPlayer(field.space, { x: 9, z: 9 }, 'carol', { character: wounded(40) });
    return { ...field, given: () => healthGap(field.space, bob.entityId, carol.entityId) };
  }

  it('heals on at the rank it was put on with, from the seconds it had left', () => {
    const first = renewed(3);
    first.steps(6 * 20);
    const carried = first.space.handOver(first.bob.entityId, false)!.transient;
    expect(carried.effects).toEqual([{ effectId: 'renewing', seconds: 4, sourceId: first.alice.entityId, rank: 3, heal: { seconds: 1, owed: 0 } }]);

    const second = arrive(first.bob, carried);
    second.steps(100);
    // Four ticks of 4 at the third rank, and nothing more once its seconds are up.
    expect(second.given()).toBe(16);
  });

  it('gives through a door between its ticks, its part of a whole owed included, what it gives with no door', () => {
    const control = renewed(1);
    control.steps(12 * 20);
    expect(control.given()).toBe(25);

    const first = renewed(1);
    first.steps(3.5 * 20);
    const before = first.given();
    expect(before).toBe(7);
    const carried = first.space.handOver(first.bob.entityId, false)!.transient;
    expect(carried.effects.map(({ heal }) => heal)).toEqual([{ seconds: 0.5, owed: 0.5 }]);
    const second = arrive(first.bob, carried);
    second.steps(12 * 20);
    expect(before + second.given()).toBe(25);
  });

  it('gives through a door with a tick already due and not yet given what it gives with no door', async () => {
    const first = renewed(1);
    first.clock.ms += 1010;
    const carried = first.space.handOver(first.bob.entityId, false)!.transient;
    const given = payloads(await collectMessages(first.bob.outbox), 'energy').at(-1)!.healthCurrent - 40;
    expect(given).toBe(2);
    expect(carried.effects.map(({ heal }) => heal)).toEqual([{ seconds: 0.99, owed: 0.5 }]);
    const second = arrive(first.bob, carried);
    second.steps(12 * 20);
    expect(given + second.given()).toBe(25);
  });
});

describe('Radiance', () => {
  it('heals every standing dreamer within five metres of the Healer, the Healer included, and none further or fallen', () => {
    const { space } = arena({}, { ghost: false });
    const alice = attachPlayer(space, ALICE_AT, 'alice', { character: { ...HEALER, ...wounded(50) }, inventory: [MOONSTONE_IN_HAND] });
    const near = attachPlayer(space, { x: 9.9, z: 5 }, 'near', { character: wounded(50) });
    const far = attachPlayer(space, { x: 10.1, z: 5 }, 'far', { character: wounded(50) });
    const fallen = attachPlayer(space, { x: 6, z: 5 }, 'fallen', { character: wounded(0) });
    space.handleUseAbility('radiance', alice.entityId);
    expect([alice, near, far, fallen].map(({ entityId }) => energyOf(space, entityId).healthCurrent)).toEqual([65, 65, 50, 0]);
    expect(energyOf(space, alice.entityId).spiritCurrent).toBe(78);
  });
});

describe("a Healer's threat", () => {
  /** A Ghost at `GHOST_AT`, keeping to ground reaching 6 m south and east of it. */
  const withGround = () => arena({ monsterSpawns: [makeMonsterSpawn(GHOST_AT, 6)] });
  /** In the Ghost's reach and its ground, and nearer to it than `BESIDE_GHOST`. */
  const NEARER: Point = { x: 10.6, z: 10.2 };
  const struckBy = (messages: readonly SomnioMessage[]) => payloads(messages, 'blow').flatMap((blow) => (blow.attackerId === GHOST ? [blow.targetId] : []));

  it('rises by what Deep mend heals, turning the Ghost on the Healer, and Calm halves it, turning it back on the Fighter', async () => {
    const { space, dice, steps } = withGround();
    // One landed swing raises 11 threat; Deep mend's 35 raises 17.5, and Calm leaves 8.75 of it.
    const fighter = attachPlayer(space, BESIDE_GHOST, 'fighter', {
      character: { lucidity: lucidity('fighter', { strike: 1 }), ...wounded(60) },
      inventory: [CUDGEL_IN_HAND],
    });
    const healer = attachPlayer(space, NEARER, 'healer', { character: HEALER, inventory: [MOONSTONE_IN_HAND] });
    attackGhost(space, fighter.entityId);
    steps(1);
    space.handleEngage(false, fighter.entityId);
    dice.hit = false;
    space.handleTarget(fighter.entityId, healer.entityId);
    space.handleUseAbility('deep-mend', healer.entityId);
    steps(CHANNEL_STEPS + 1);
    space.handleUseAbility('calm', healer.entityId);
    steps(30);
    expect(struckBy(await collectMessages(healer.outbox))).toEqual([fighter.entityId, healer.entityId, fighter.entityId]);
  });

  it('rises at half the rate for what the Healer heals while Calm holds', async () => {
    const { space, dice, steps } = withGround();
    const fighter = attachPlayer(space, BESIDE_GHOST, 'fighter', {
      character: { lucidity: lucidity('fighter', { strike: 1 }), ...wounded(60) },
      inventory: [CUDGEL_IN_HAND],
    });
    const healer = attachPlayer(space, NEARER, 'healer', { character: HEALER, inventory: [MOONSTONE_IN_HAND] });
    attackGhost(space, fighter.entityId);
    steps(1);
    space.handleEngage(false, fighter.entityId);
    dice.hit = false;
    space.handleTarget(fighter.entityId, healer.entityId);
    // Calmed first, Deep mend's 35 raises 8.75, under the 11 of the Fighter's swing; uncalmed it would raise 17.5.
    space.handleUseAbility('calm', healer.entityId);
    steps(15);
    space.handleUseAbility('deep-mend', healer.entityId);
    steps(CHANNEL_STEPS + 30);
    // Mended: 51 after the Ghost's one landed strike, then Deep mend's 35, and a unit recovered.
    expect(energyOf(space, fighter.entityId).healthCurrent).toBe(87);
    expect(struckBy(await collectMessages(healer.outbox))).toEqual([fighter.entityId, fighter.entityId, fighter.entityId]);
  });
});
