import { describe, expect, it } from 'vitest';
import { COMBAT, PRACTICE } from '@somnio/core';
import type { Character, InventoryRow, Point } from '@somnio/core';
import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import type { Energy, SomnioMessage } from '@somnio/protocol';
import { ConnectionOutbox } from '../src/connection/outbox.ts';
import { BESIDE_GHOST, CUDGEL_IN_HAND, GHOST, MONDSTEIN_IN_HAND, arena, characterOf, energy, energyOf, lucidity, payloads } from './support/combat.ts';
import { collectMessages } from './support/frames.ts';
import { attachPlayer, makeSectorLine } from './support/sectorFactory.ts';

const HEALER_AT: Point = { x: 5, z: 5 };
/** Within a Mondstein's reach of `HEALER_AT`. */
const TARGET_AT: Point = { x: 5, z: 5.7 };
const HEALER: Partial<Character> = { lucidity: lucidity('heiler', { touch: 2, 'drawing-back': 1 }) };
const FALLEN: Partial<Character> = { energy: energy({ healthCurrent: 0 }) };

type Arena = ReturnType<typeof arena>;

/** Steps until the dreamer stands and returns how many steps that took. Tending mends them from the step after. */
function stepsUntilRaised({ space, steps }: Arena, entityId: string): number {
  let count = 0;
  while (space.isFallen(entityId) && count < 200) {
    steps(1);
    count += 1;
  }
  return count;
}

function pair(
  space: Arena['space'],
  healer: Partial<Character> = HEALER,
  target: Partial<Character> = FALLEN,
  inventory: InventoryRow[] = [MONDSTEIN_IN_HAND],
) {
  return {
    healer: attachPlayer(space, HEALER_AT, 'healer', { character: healer, inventory }),
    target: attachPlayer(space, TARGET_AT, 'target', { character: target }),
  };
}

describe('mending', () => {
  it("restores part of the tended dreamer's health for the Heiler's spirit, once per touch interval, until they are let go", () => {
    const { space, steps } = arena({}, { ghost: false });
    const { healer, target } = pair(space, HEALER, { energy: energy({ healthCurrent: 50 }) });
    space.handleTend(target.entityId, healer.entityId);
    steps(1);
    expect(energyOf(space, target.entityId).healthCurrent).toBe(60);
    expect(energyOf(space, healer.entityId).spiritCurrent).toBe(92);
    steps(19);
    expect(energyOf(space, target.entityId).healthCurrent).toBe(60);
    steps(2);
    expect(energyOf(space, target.entityId).healthCurrent).toBe(70);
    space.handleTend(undefined, healer.entityId);
    steps(22);
    expect(energyOf(space, target.entityId).healthCurrent).toBeLessThan(80);
  });

  it('shows each mend, with no amount, to everyone who sees the mended dreamer', async () => {
    const { space, steps } = arena({}, { ghost: false });
    const { healer, target } = pair(space, HEALER, { energy: energy({ healthCurrent: 50 }) });
    const bystander = attachPlayer(space, { x: 8, z: 8 }, 'bystander');
    space.handleTend(target.entityId, healer.entityId);
    steps(1);
    for (const player of [healer, target, bystander]) {
      expect(payloads(await collectMessages(player.outbox), 'mend')).toEqual([{ targetId: target.entityId }]);
    }
  });

  /** The arena is the west of a line of three sectors, so a player in the east sees the mended dreamer's sector and not the Heiler's. */
  it("shows a mend to whoever sees the mended dreamer's sector, not the Heiler's", async () => {
    const { space, steps } = arena({}, { ghost: false, sectors: makeSectorLine().slice(1) });
    const healer = attachPlayer(space, { x: 19.7, z: 10 }, 'healer', { character: HEALER, inventory: [MONDSTEIN_IN_HAND] });
    const target = attachPlayer(space, { x: 20.3, z: 10 }, 'target', { character: { energy: energy({ healthCurrent: 50 }) } });
    const east = attachPlayer(space, { x: 45, z: 10 }, 'east');
    space.handleTend(target.entityId, healer.entityId);
    steps(1);
    expect(payloads(await collectMessages(east.outbox), 'mend')).toEqual([{ targetId: target.entityId }]);
  });

  it.each<[string, (healerId: string) => string]>([
    ['themselves', (healerId) => healerId],
    ['someone who is not there', () => 'nobody'],
  ])('tends no one when asked to tend %s, letting go of whoever they tended', (_label, asked) => {
    const { space, steps } = arena({}, { ghost: false });
    const { healer, target } = pair(space, { ...HEALER, energy: energy({ healthCurrent: 50 }) }, { energy: energy({ healthCurrent: 50 }) });
    space.handleTend(target.entityId, healer.entityId);
    space.handleTend(asked(healer.entityId), healer.entityId);
    steps(1);
    expect([healer, target].map((player) => energyOf(space, player.entityId).healthCurrent)).toEqual([50, 50]);
  });

  it('mends more with Depth, and no further than full', () => {
    const { space, steps } = arena({}, { ghost: false });
    const deep = { lucidity: lucidity('heiler', { touch: 1, depth: 2 }) };
    const { healer, target } = pair(space, deep, { energy: energy({ healthCurrent: 85 }) });
    space.handleTend(target.entityId, healer.entityId);
    steps(1);
    expect(energyOf(space, target.entityId).healthCurrent).toBe(100);
  });

  it.each<[string, Partial<Character>, InventoryRow[], Partial<Energy>]>([
    ['from anyone but a Heiler', { lucidity: lucidity('kaempfer', { strike: 1 }) }, [MONDSTEIN_IN_HAND], {}],
    ['from a Heiler with the Mondstein put away', HEALER, [{ ...MONDSTEIN_IN_HAND, equippedHand: undefined }], {}],
    ['from a Heiler with the Mondstein in the other hand', HEALER, [{ ...MONDSTEIN_IN_HAND, equippedHand: 'left' }, CUDGEL_IN_HAND], {}],
    ['from a Heiler with too little spirit', { ...HEALER, energy: energy({ spiritCurrent: 7 }) }, [MONDSTEIN_IN_HAND], {}],
    ['for a dreamer at full health', HEALER, [MONDSTEIN_IN_HAND], { healthCurrent: 100 }],
  ])('does nothing %s', async (_label, healerCharacter, inventory, targetEnergy) => {
    const { space, steps } = arena({}, { ghost: false });
    const { healer, target } = pair(space, healerCharacter, { energy: energy({ healthCurrent: 50, ...targetEnergy }) }, inventory);
    const before = [energyOf(space, healer.entityId), energyOf(space, target.entityId)];
    space.handleTend(target.entityId, healer.entityId);
    steps(1);
    expect([energyOf(space, healer.entityId), energyOf(space, target.entityId)]).toEqual(before);
    expect(payloads(await collectMessages(target.outbox), 'mend')).toEqual([]);
  });

  it("does not reach a dreamer beyond a body's contact and the reach slack", () => {
    const { space, steps } = arena({}, { ghost: false });
    const healer = attachPlayer(space, HEALER_AT, 'healer', { character: HEALER, inventory: [MONDSTEIN_IN_HAND] });
    const target = attachPlayer(space, { x: 5, z: 5.9 }, 'target', { character: { energy: energy({ healthCurrent: 50 }) } });
    space.handleTend(target.entityId, healer.entityId);
    steps(1);
    expect(energyOf(space, target.entityId).healthCurrent).toBe(50);
  });

  it('mends the holder who uses the Mondstein in hand, for the same spirit, and shows it', async () => {
    const { space } = arena({}, { ghost: false });
    const hurt = { ...HEALER, energy: energy({ healthCurrent: 50 }) };
    const healer = attachPlayer(space, HEALER_AT, 'healer', { character: hurt, inventory: [MONDSTEIN_IN_HAND] });
    space.handleUseItem(MONDSTEIN_IN_HAND.slot, healer.entityId);
    expect(energyOf(space, healer.entityId)).toMatchObject({ healthCurrent: 60, spiritCurrent: 92 });
    expect(payloads(await collectMessages(healer.outbox), 'mend')).toEqual([{ targetId: healer.entityId }]);
  });

  it.each<[string, Partial<Character>, InventoryRow[], number]>([
    ['a fallen holder', { ...HEALER, energy: energy({ healthCurrent: 0 }) }, [MONDSTEIN_IN_HAND], MONDSTEIN_IN_HAND.slot],
    [
      'a Mondstein not in hand',
      { ...HEALER, energy: energy({ healthCurrent: 50 }) },
      [{ ...MONDSTEIN_IN_HAND, equippedHand: undefined }],
      MONDSTEIN_IN_HAND.slot,
    ],
    [
      'any other row',
      { ...HEALER, energy: energy({ healthCurrent: 50 }) },
      [MONDSTEIN_IN_HAND, { ...CUDGEL_IN_HAND, equippedHand: undefined }],
      CUDGEL_IN_HAND.slot,
    ],
    ['a slot that holds nothing', { ...HEALER, energy: energy({ healthCurrent: 50 }) }, [MONDSTEIN_IN_HAND], 9],
  ])('does nothing on use for %s', (_label, character, inventory, slot) => {
    const { space } = arena({}, { ghost: false });
    const healer = attachPlayer(space, HEALER_AT, 'healer', { character, inventory });
    const before = energyOf(space, healer.entityId);
    space.handleUseItem(slot, healer.entityId);
    expect(energyOf(space, healer.entityId)).toEqual(before);
  });
});

describe('raising', () => {
  /** Two more Heilers' places within a Mondstein's reach of `TARGET_AT`. */
  const BESIDE_TARGET: Point[] = [
    { x: 5.7, z: 5.7 },
    { x: 4.3, z: 5.7 },
  ];

  function heiler(space: Arena['space'], at: Point, name: string, character: Partial<Character> = HEALER) {
    return attachPlayer(space, at, name, { character, inventory: [MONDSTEIN_IN_HAND] });
  }

  /** Who held each raise frame, and how it stood. */
  async function holds(outbox: ConnectionOutbox) {
    return payloads(await collectMessages(outbox), 'raising').map(({ state, healerIds }) => ({ state, healerIds }));
  }

  /** The spirit a Heiler's frames show charged. Each frame has one cause, so the falls are the raise's charges and the rises are recovery. */
  function spiritCharged(messages: readonly SomnioMessage[]): number {
    const spirit = payloads(messages, 'energy').map((sent) => sent.spiritCurrent);
    return spirit.reduce((sum, value, index) => sum + Math.max(0, (spirit[index - 1] ?? COMBAT.basePool) - value), 0);
  }

  it.each<[string, Partial<Character>]>([
    ['a Heiler who has not learned Drawing back', { lucidity: lucidity('heiler', { touch: 3 }) }],
    ['a Heiler short of the full spirit cost', { ...HEALER, energy: energy({ spiritCurrent: COMBAT.raise.spiritCost - 1 }) }],
  ])('does not begin for %s', async (_label, healerCharacter) => {
    const { space, steps } = arena({}, { ghost: false });
    const { healer, target } = pair(space, healerCharacter);
    space.handleTend(target.entityId, healer.entityId);
    steps(1);
    expect(space.isFallen(target.entityId)).toBe(true);
    expect(payloads(await collectMessages(target.outbox), 'raising')).toEqual([]);
  });

  it('raises the fallen after the raise time for exactly the spirit cost, in whole numbers', async () => {
    const field = arena({}, { ghost: false });
    const { space, steps } = field;
    const { healer, target } = pair(space);
    space.handleTend(target.entityId, healer.entityId);
    steps(119);
    expect(space.isFallen(target.entityId)).toBe(true);
    expect(stepsUntilRaised(field, target.entityId)).toBeLessThanOrEqual(2);
    expect(energyOf(space, target.entityId).healthCurrent).toBe(25);

    const raising = { targetId: target.entityId, healerIds: [healer.entityId] };
    // The Mondstein reaches the dreamer again on every step, and takes hold no more.
    expect(payloads(await collectMessages(target.outbox), 'raising')).toEqual([
      { ...raising, state: 'holding', progress: 0, seconds: 6 },
      { ...raising, state: 'done', progress: 1, seconds: 0 },
    ]);
    const messages = await collectMessages(healer.outbox);
    expect(payloads(messages, 'energy').every((sent) => Number.isInteger(sent.spiritCurrent))).toBe(true);
    expect(spiritCharged(messages)).toBe(COMBAT.raise.spiritCost);
  });

  it.each<[number, number, number]>([
    [2, 61, 20],
    [3, 41, 13],
  ])('raises in a share of the time with %i Heilers holding on, each paying their share of the spirit', async (count, most, each) => {
    const field = arena({}, { ghost: false });
    const { space } = field;
    const { healer, target } = pair(space);
    const healers = [healer, ...BESIDE_TARGET.slice(0, count - 1).map((at, index) => heiler(space, at, `other-${index}`))];
    for (const one of healers) space.handleTend(target.entityId, one.entityId);
    // Within a step of the raise time shared among them.
    const took = stepsUntilRaised(field, target.entityId);
    expect(took).toBeGreaterThanOrEqual(most - 1);
    expect(took).toBeLessThanOrEqual(most);
    const charged = await Promise.all(healers.map(async (one) => spiritCharged(await collectMessages(one.outbox))));
    expect(charged).toEqual(healers.map(() => each));
    expect(charged.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(COMBAT.raise.spiritCost);
  });

  it('lets a second Heiler join a raise under way on the next step', async () => {
    const { space, steps } = arena({}, { ghost: false });
    const { healer, target } = pair(space);
    const other = heiler(space, BESIDE_TARGET[0]!, 'other');
    space.handleTend(target.entityId, healer.entityId);
    steps(20);
    space.handleTend(target.entityId, other.entityId);
    steps(1);
    for (const player of [healer, other]) {
      const [alone, together] = payloads(await collectMessages(player.outbox), 'raising');
      expect(alone).toMatchObject({ healerIds: [healer.entityId], state: 'holding', seconds: 6 });
      expect(together).toMatchObject({ healerIds: [healer.entityId, other.entityId], state: 'holding' });
      expect(together!.progress).toBeCloseTo(1 / 6, 9);
      expect(together!.seconds).toBeCloseTo(2.5, 9);
    }
  });

  it('keeps the progress when one of two Heilers steps out of reach, and finishes it at the pace of the one left', async () => {
    const field = arena({}, { ghost: false });
    const { space, steps } = field;
    const { healer, target } = pair(space);
    const other = heiler(space, BESIDE_TARGET[0]!, 'other');
    space.handleTend(target.entityId, healer.entityId);
    space.handleTend(target.entityId, other.entityId);
    steps(20);
    space.handleMove({ x: 5.7, z: 4.7, facing: 0, gait: 'jog' }, other.entityId);
    const rest = stepsUntilRaised(field, target.entityId);
    const raisings = payloads(await collectMessages(target.outbox), 'raising');
    expect(raisings.map(({ state, healerIds }) => ({ state, healerIds }))).toEqual([
      { state: 'holding', healerIds: [healer.entityId] },
      { state: 'holding', healerIds: [healer.entityId, other.entityId] },
      { state: 'holding', healerIds: [healer.entityId] },
      { state: 'done', healerIds: [healer.entityId] },
    ]);
    expect(raisings[2]!.progress).toBeCloseTo(1 / 3, 9);
    expect(raisings[2]!.seconds).toBeCloseTo(4, 9);
    // The four seconds left, at one Heiler's pace.
    expect(rest).toBeGreaterThanOrEqual(80);
    expect(rest).toBeLessThanOrEqual(81);
  });

  it('lets no more Heilers hold one raise than its frame may name, and the next take a slot as it frees', async () => {
    const { space, steps } = arena({}, { ghost: false });
    const { healer, target } = pair(space);
    const others = Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxRaiseHealers }, (_, index) => heiler(space, HEALER_AT, `other-${index}`));
    const turnedAway = others.at(-1)!.entityId;
    for (const one of [healer, ...others]) space.handleTend(target.entityId, one.entityId);
    steps(1);
    // Two checkpoints need two outboxes: collecting one finishes it.
    const full = payloads(await collectMessages(healer.outbox), 'raising').at(-1)!;
    expect(full.healerIds).toHaveLength(SOMNIO_PROTOCOL_CONSTANTS.maxRaiseHealers);
    expect(full.healerIds).not.toContain(turnedAway);
    space.handleTend(undefined, healer.entityId);
    steps(1);
    // Turned away without spending their touch, they take the freed slot on the very next step.
    const freed = payloads(await collectMessages(target.outbox), 'raising').at(-1)!;
    expect(freed.healerIds).toHaveLength(SOMNIO_PROTOCOL_CONSTANTS.maxRaiseHealers);
    expect(freed.healerIds).toContain(turnedAway);
    expect(freed.healerIds).not.toContain(healer.entityId);
  });

  it.each<[string, number, boolean]>([
    ["joins with a mend's worth of spirit", COMBAT.mend.spiritCost, true],
    ['does not join with less', COMBAT.mend.spiritCost - 1, false],
  ])('a second Heiler %s', async (_label, spiritCurrent, joins) => {
    const { space, steps } = arena({}, { ghost: false });
    const { healer, target } = pair(space);
    const other = heiler(space, BESIDE_TARGET[0]!, 'other', { ...HEALER, energy: energy({ spiritCurrent }) });
    space.handleTend(target.entityId, healer.entityId);
    space.handleTend(target.entityId, other.entityId);
    steps(1);
    expect(await holds(target.outbox)).toEqual([
      { state: 'holding', healerIds: [healer.entityId] },
      ...(joins ? [{ state: 'holding', healerIds: [healer.entityId, other.entityId] }] : []),
    ]);
  });

  it('drops a Heiler who joined with little spirit once it runs out, and goes on with the other', async () => {
    const field = arena({}, { ghost: false });
    const { space } = field;
    const { healer, target } = pair(space);
    const other = heiler(space, BESIDE_TARGET[0]!, 'other', { ...HEALER, energy: energy({ spiritCurrent: COMBAT.mend.spiritCost }) });
    space.handleTend(target.entityId, healer.entityId);
    space.handleTend(target.entityId, other.entityId);
    expect(stepsUntilRaised(field, target.entityId)).toBeLessThanOrEqual(121);
    expect(await holds(target.outbox)).toEqual([
      { state: 'holding', healerIds: [healer.entityId] },
      { state: 'holding', healerIds: [healer.entityId, other.entityId] },
      { state: 'holding', healerIds: [healer.entityId] },
      { state: 'done', healerIds: [healer.entityId] },
    ]);
  });

  it('breaks off when the Heiler steps out of reach, and begins again at once when they step back', async () => {
    const { space, steps } = arena({}, { ghost: false });
    const { healer, target } = pair(space);
    space.handleTend(target.entityId, healer.entityId);
    steps(60);
    space.handleMove({ x: 5, z: 4.7, facing: 0, gait: 'jog' }, healer.entityId);
    steps(1);
    // Back on the step after the break: the touch spent on taking hold is long past.
    space.handleMove({ x: 5, z: 5, facing: 0, gait: 'jog' }, healer.entityId);
    steps(1);
    const raising = { targetId: target.entityId, healerIds: [healer.entityId] };
    expect(payloads(await collectMessages(target.outbox), 'raising')).toEqual([
      { ...raising, state: 'holding', progress: 0, seconds: 6 },
      { ...raising, state: 'broken', progress: 0, seconds: 0 },
      { ...raising, state: 'holding', progress: 0, seconds: 6 },
    ]);
  });

  it.each<[string, (space: Arena['space'], healerId: string) => void]>([
    ['puts the Mondstein away', (space, healerId) => space.handleEquipToggle(MONDSTEIN_IN_HAND.slot, undefined, healerId)],
    ['leaves the space', (space, healerId) => space.detach(healerId, true)],
    ['lets go of them', (space, healerId) => space.handleTend(undefined, healerId)],
  ])('breaks off when the Heiler %s', async (_label, act) => {
    const { space, steps } = arena({}, { ghost: false });
    const { healer, target } = pair(space);
    space.handleTend(target.entityId, healer.entityId);
    steps(10);
    act(space, healer.entityId);
    steps(1);
    expect(payloads(await collectMessages(target.outbox), 'raising').map((sent) => sent.state)).toEqual(['holding', 'broken']);
  });

  it('breaks once, naming both, when both Heilers let go on the same step', async () => {
    const { space, steps } = arena({}, { ghost: false });
    const { healer, target } = pair(space);
    const other = heiler(space, BESIDE_TARGET[0]!, 'other');
    space.handleTend(target.entityId, healer.entityId);
    space.handleTend(target.entityId, other.entityId);
    steps(10);
    space.handleTend(undefined, healer.entityId);
    space.handleTend(undefined, other.entityId);
    steps(1);
    expect((await holds(target.outbox)).at(-1)).toEqual({ state: 'broken', healerIds: [healer.entityId, other.entityId] });
  });

  it.each<[number, boolean]>([
    [COMBAT.raise.spiritCost - 1, false],
    [COMBAT.raise.spiritCost, true],
  ])('hands no raise its last Heiler let go on to a Heiler tending with %i spirit, who has to begin anew', async (spiritCurrent, begins) => {
    const { space, steps } = arena({}, { ghost: false });
    const { healer, target } = pair(space);
    const other = heiler(space, BESIDE_TARGET[0]!, 'other', { ...HEALER, energy: energy({ spiritCurrent }) });
    space.handleTend(target.entityId, healer.entityId);
    steps(10);
    space.handleTend(undefined, healer.entityId);
    space.handleTend(target.entityId, other.entityId);
    steps(1);
    const raisings = payloads(await collectMessages(target.outbox), 'raising');
    expect(raisings.slice(1)).toEqual([
      { targetId: target.entityId, healerIds: [healer.entityId], state: 'broken', progress: 0, seconds: 0 },
      ...(begins ? [{ targetId: target.entityId, healerIds: [other.entityId], state: 'holding', progress: 0, seconds: 6 }] : []),
    ]);
  });

  it('spends the touch on taking hold, so the next take-hold is no sooner than a touch interval later', async () => {
    const { space, steps } = arena({}, { ghost: false });
    const { healer, target: first } = pair(space);
    const second = attachPlayer(space, { x: 5.7, z: 5 }, 'second', { character: FALLEN });
    space.handleTend(first.entityId, healer.entityId);
    steps(1);
    space.handleTend(second.entityId, healer.entityId);
    steps(5);
    // Two checkpoints need two outboxes: collecting one finishes it.
    const heldAndBroken = payloads(await collectMessages(healer.outbox), 'raising').map(({ targetId, state }) => ({ targetId, state }));
    expect(heldAndBroken).toEqual([
      { targetId: first.entityId, state: 'holding' },
      { targetId: first.entityId, state: 'broken' },
    ]);
    steps(20);
    const onSecond = payloads(await collectMessages(second.outbox), 'raising').filter((raising) => raising.targetId === second.entityId);
    expect(onSecond.map((raising) => raising.state)).toEqual(['holding']);
  });

  it('spends the touch of a Heiler who joins, so they take hold again no sooner than a touch interval later', async () => {
    const { space, steps } = arena({}, { ghost: false });
    const { healer, target } = pair(space);
    const other = heiler(space, BESIDE_TARGET[0]!, 'other');
    space.handleTend(target.entityId, healer.entityId);
    space.handleTend(target.entityId, other.entityId);
    steps(5);
    space.handleTend(undefined, other.entityId);
    steps(1);
    space.handleTend(target.entityId, other.entityId);
    // Up to the step before the other's touch interval ends, 20 steps after they joined.
    steps(14);
    expect(await holds(healer.outbox)).toEqual([
      { state: 'holding', healerIds: [healer.entityId] },
      { state: 'holding', healerIds: [healer.entityId, other.entityId] },
      { state: 'holding', healerIds: [healer.entityId] },
    ]);
    steps(1);
    expect((await holds(other.outbox)).at(-1)).toEqual({ state: 'holding', healerIds: [healer.entityId, other.entityId] });
  });

  /** 48 steps of 50 ms add up to a hair under the 2.4 s that come to 16 spirit, and 47 steps come to 15.67 of them. */
  it.each([
    [48, 16],
    [47, 15],
  ])('charges a Heiler who drops out after %i steps the %i whole units of spirit their seconds held come to', async (held, charged) => {
    const { space, steps } = arena({}, { ghost: false });
    const { healer, target } = pair(space);
    const other = heiler(space, BESIDE_TARGET[0]!, 'other');
    space.handleTend(target.entityId, healer.entityId);
    space.handleTend(target.entityId, other.entityId);
    steps(held);
    space.handleTend(undefined, other.entityId);
    steps(1);
    expect(spiritCharged(await collectMessages(other.outbox))).toBe(charged);
  });

  it('lets go of a Heiler who leaves, though they are back under the same id before the next step', async () => {
    const { space, steps } = arena({}, { ghost: false });
    const { healer, target } = pair(space);
    space.handleTend(target.entityId, healer.entityId);
    steps(20);
    space.detach(healer.entityId, false);
    space.attach(healer.character, [MONDSTEIN_IN_HAND], new ConnectionOutbox(4096), 0);
    space.handleTend(target.entityId, healer.entityId);
    steps(1);
    const raising = { targetId: target.entityId, healerIds: [healer.entityId] };
    // The raise broke when they left, and the one they take hold of again starts from nothing.
    expect(payloads(await collectMessages(target.outbox), 'raising').slice(1)).toEqual([
      { ...raising, state: 'broken', progress: 0, seconds: 0 },
      { ...raising, state: 'holding', progress: 0, seconds: 6 },
    ]);
  });

  it('lets go of one of two Heilers who leaves, though they are back under the same id before the next step', async () => {
    const { space, steps } = arena({}, { ghost: false });
    const { healer, target } = pair(space);
    const other = heiler(space, BESIDE_TARGET[0]!, 'other');
    space.handleTend(target.entityId, healer.entityId);
    space.handleTend(target.entityId, other.entityId);
    steps(20);
    space.detach(other.entityId, false);
    space.attach(other.character, [MONDSTEIN_IN_HAND], new ConnectionOutbox(4096), 0);
    space.handleTend(target.entityId, other.entityId);
    steps(1);
    // Dropped as they left, and back only by taking hold again.
    expect((await holds(target.outbox)).slice(2)).toEqual([
      { state: 'holding', healerIds: [healer.entityId] },
      { state: 'holding', healerIds: [healer.entityId, other.entityId] },
    ]);
  });

  it('lets a Heiler take hold again once their touch interval has passed, and at once with a fresh touch', async () => {
    const { space, steps } = arena({}, { ghost: false });
    const { healer, target } = pair(space);
    const other = heiler(space, BESIDE_TARGET[0]!, 'other');
    space.handleTend(target.entityId, healer.entityId);
    steps(1);
    space.handleTend(undefined, healer.entityId);
    space.handleTend(target.entityId, other.entityId);
    steps(1);
    space.handleTend(target.entityId, healer.entityId);
    // Up to the step before the healer's touch interval ends, 20 steps after they took hold.
    steps(18);
    expect(await holds(healer.outbox)).toEqual([
      { state: 'holding', healerIds: [healer.entityId] },
      { state: 'broken', healerIds: [healer.entityId] },
      { state: 'holding', healerIds: [other.entityId] },
    ]);
    steps(1);
    expect((await holds(other.outbox)).at(-1)).toEqual({ state: 'holding', healerIds: [other.entityId, healer.entityId] });

    const watching = attachPlayer(space, { x: 8, z: 8 }, 'watching');
    space.detach(healer.entityId, false);
    steps(1);
    const back = new ConnectionOutbox(4096);
    space.attach(healer.character, [MONDSTEIN_IN_HAND], back, 0);
    space.handleTend(target.entityId, healer.entityId);
    steps(1);
    expect(await holds(watching.outbox)).toEqual([
      { state: 'holding', healerIds: [other.entityId, healer.entityId] },
      { state: 'holding', healerIds: [other.entityId] },
      { state: 'holding', healerIds: [other.entityId, healer.entityId] },
    ]);
  });

  it('keeps no Heiler who joined the space first, letting go and taking hold again, from a second one holding on', async () => {
    const field = arena({}, { ghost: false });
    const { space, steps } = field;
    const { healer: cheat, target } = pair(space);
    const honest = heiler(space, BESIDE_TARGET[0]!, 'honest');
    space.handleTend(target.entityId, cheat.entityId);
    space.handleTend(target.entityId, honest.entityId);
    steps(20);
    // The cheat lets go just before the step on which their touch interval ends, and takes hold again just after it.
    space.handleTend(undefined, cheat.entityId);
    steps(1);
    space.handleTend(target.entityId, cheat.entityId);
    stepsUntilRaised(field, target.entityId);
    const raisings = await holds(target.outbox);
    expect(raisings).toEqual([
      { state: 'holding', healerIds: [cheat.entityId] },
      { state: 'holding', healerIds: [cheat.entityId, honest.entityId] },
      { state: 'holding', healerIds: [honest.entityId] },
      { state: 'holding', healerIds: [honest.entityId, cheat.entityId] },
      { state: 'done', healerIds: [honest.entityId, cheat.entityId] },
    ]);
  });

  /** The arena is the west of a line of three sectors: a player in the east sees the middle and the east, not the arena. */
  it('shows a raise under way to whoever comes into view of it, after the fallen body, and to no one who already saw it', async () => {
    const { space, steps } = arena({}, { ghost: false, sectors: makeSectorLine().slice(1) });
    const { healer, target } = pair(space);
    const watching = attachPlayer(space, { x: 10, z: 10 }, 'watching');
    const crossing = attachPlayer(space, { x: 41, z: 10 }, 'crossing');
    space.handleTend(target.entityId, healer.entityId);
    steps(30);
    const joining = attachPlayer(space, { x: 8, z: 8 }, 'joining');
    space.handleMove({ x: 39, z: 10, facing: 0, gait: 'jog' }, crossing.entityId);
    for (const player of [joining, crossing]) {
      const messages = await collectMessages(player.outbox);
      const body = messages.findIndex((message) => message.tag === 'entity' && message.payload.id === target.entityId);
      const shown = messages.findIndex((message) => message.tag === 'raising');
      expect(body).toBeGreaterThanOrEqual(0);
      expect(shown).toBeGreaterThan(body);
      const raising = payloads(messages, 'raising');
      expect(raising).toHaveLength(1);
      expect(raising[0]).toMatchObject({ targetId: target.entityId, healerIds: [healer.entityId], state: 'holding' });
      expect(raising[0]!.progress).toBeCloseTo(1 / 4, 9);
      expect(raising[0]!.seconds).toBeCloseTo(4.5, 9);
    }
    expect(await holds(watching.outbox)).toEqual([{ state: 'holding', healerIds: [healer.entityId] }]);
  });

  /** The whole cost is there at the start, and a Heiler can still spend it elsewhere while the raise runs. */
  it("breaks off when the Heiler's spirit runs out", async () => {
    const { clock, space, steps } = arena({}, { ghost: false });
    const spent = { ...HEALER, energy: energy({ healthCurrent: 50, spiritCurrent: COMBAT.raise.spiritCost }) };
    const { healer, target } = pair(space, spent);
    space.handleTend(target.entityId, healer.entityId);
    steps(160, () => {
      if (clock.ms % 1000 === 0) space.handleUseItem(MONDSTEIN_IN_HAND.slot, healer.entityId);
    });
    expect(space.isFallen(target.entityId)).toBe(true);
    expect(payloads(await collectMessages(target.outbox), 'raising').map((sent) => sent.state)).toEqual(['holding', 'broken']);
  });

  it('ends with exactly one broken, on the following step, when the Heiler falls, who is corrected to where they stood', async () => {
    const { space, steps } = arena();
    const healer = heiler(space, BESIDE_GHOST, 'healer', { ...HEALER, energy: energy({ healthCurrent: 9 }) });
    const target = attachPlayer(space, { x: 10.6, z: 10.7 }, 'target', { character: FALLEN });
    space.handleTend(target.entityId, healer.entityId);
    steps(1);
    expect(space.isFallen(healer.entityId)).toBe(true);
    steps(21);
    const messages = await collectMessages(target.outbox);
    expect(payloads(messages, 'raising').map((raising) => raising.state)).toEqual(['holding', 'broken']);
    // The break follows the fall: the healer's condition is announced a step before it.
    const order = messages.flatMap((message) =>
      message.tag === 'raising' || (message.tag === 'condition' && message.payload.condition === 'fallen') ? [message.tag] : [],
    );
    expect(order).toEqual(['raising', 'condition', 'raising']);
    expect(payloads(await collectMessages(healer.outbox), 'correction')).toEqual([BESIDE_GHOST]);
  });

  it('lets a Heiler who falls go of the dreamer they tended, and has them tend no one they ask for while fallen', () => {
    const field = arena();
    const { space, steps, dice } = field;
    const healer = heiler(space, BESIDE_GHOST, 'healer', { ...HEALER, energy: energy({ healthCurrent: 9 }) });
    const hurt = attachPlayer(space, { x: 10.6, z: 10.7 }, 'hurt', { character: { energy: energy({ healthCurrent: 50 }) } });
    space.handleTend(hurt.entityId, healer.entityId);
    steps(1);
    expect(space.isFallen(healer.entityId)).toBe(true);
    expect(energyOf(space, hurt.entityId).healthCurrent).toBe(60);
    dice.hit = false;
    space.handleTend(hurt.entityId, healer.entityId);

    const rescuer = heiler(space, { x: 9.4, z: 10.7 }, 'rescuer');
    space.handleTend(healer.entityId, rescuer.entityId);
    expect(stepsUntilRaised(field, healer.entityId)).toBeLessThanOrEqual(121);
    space.handleTend(undefined, rescuer.entityId);
    const spirit = energyOf(space, healer.entityId).spiritCurrent;
    steps(40);
    // Standing again with the Mondstein in hand beside them, and no touch: only recovery since.
    expect(energyOf(space, hurt.entityId).healthCurrent).toBeLessThan(70);
    expect(energyOf(space, healer.entityId).spiritCurrent).toBeGreaterThanOrEqual(spirit);
  });

  it('keeps nightmares off the raised dreamer for the grace time', async () => {
    const { clock, space, steps } = arena();
    // The fallen body stands between the nightmare and the healer, who is out of its reach behind it.
    const target = attachPlayer(space, BESIDE_GHOST, 'target', { character: FALLEN });
    const healer = heiler(space, { x: 10, z: 11.4 }, 'healer');
    space.handleTend(target.entityId, healer.entityId);
    steps(121);
    expect(space.isFallen(target.entityId)).toBe(false);
    const raisedAt = clock.ms;
    steps(99);
    expect(energyOf(space, target.entityId).healthCurrent).toBeGreaterThanOrEqual(25);
    steps(2);
    const blows = payloads(await collectMessages(healer.outbox), 'blow');
    expect(blows).toEqual([{ attackerId: GHOST, targetId: target.entityId, hit: true }]);
    expect(clock.ms - raisedAt).toBeGreaterThanOrEqual(COMBAT.raise.graceSeconds * 1000);
  });

  it('adds practice for a mend on another, half as much for one on oneself, and for a completed raise', () => {
    const field = arena({}, { ghost: false });
    const { clock, space, steps } = field;
    const studying = { lucidity: lucidity('heiler', { touch: 2, 'drawing-back': 1 }, { study: 'depth' }), energy: energy({ healthCurrent: 80 }) };
    const { healer, target } = pair(space, studying, { energy: energy({ healthCurrent: 50 }) });
    const practice = () => characterOf(space, healer.entityId).lucidity.ranks.find((held) => held.teachingId === 'depth')?.practice;
    space.handleTend(target.entityId, healer.entityId);
    steps(1);
    expect(practice()).toBe(2.5);
    space.handleTend(undefined, healer.entityId);
    clock.ms += 1000;
    space.handleUseItem(MONDSTEIN_IN_HAND.slot, healer.entityId);
    expect(practice()).toBe(3.75);

    const fallen = attachPlayer(space, { x: 5.6, z: 5 }, 'fallen', { character: FALLEN });
    clock.ms += 1000;
    space.handleTend(fallen.entityId, healer.entityId);
    expect(stepsUntilRaised(field, fallen.entityId)).toBeLessThanOrEqual(121);
    expect(practice()).toBe(13.75);
  });

  describe('practice by share', () => {
    const STUDYING: Partial<Character> = { lucidity: lucidity('heiler', { touch: 2, 'drawing-back': 1 }, { study: 'depth' }) };

    function practiceOf(space: Arena['space'], entityId: string): number | undefined {
      return characterOf(space, entityId).lucidity.ranks.find((held) => held.teachingId === 'depth')?.practice;
    }

    it('splits the practice evenly between two Heilers who held on throughout', () => {
      const field = arena({}, { ghost: false });
      const { healer, target } = pair(field.space, STUDYING);
      const other = heiler(field.space, BESIDE_TARGET[0]!, 'other', STUDYING);
      field.space.handleTend(target.entityId, healer.entityId);
      field.space.handleTend(target.entityId, other.entityId);
      stepsUntilRaised(field, target.entityId);
      for (const one of [healer, other]) expect(practiceOf(field.space, one.entityId)).toBeCloseTo(PRACTICE.raise / 2, 9);
    });

    /** Both hold for a second, the healer alone for one step, then both again for what is left. */
    it('pays a Heiler who dropped out and took hold again for both stints', () => {
      const field = arena({}, { ghost: false });
      const { space, steps } = field;
      const { healer, target } = pair(space, STUDYING);
      const other = heiler(space, BESIDE_TARGET[0]!, 'other', STUDYING);
      space.handleTend(target.entityId, healer.entityId);
      space.handleTend(target.entityId, other.entityId);
      steps(20);
      space.handleTend(undefined, other.entityId);
      steps(1);
      space.handleTend(target.entityId, other.entityId);
      stepsUntilRaised(field, target.entityId);
      const together = (COMBAT.raise.seconds - 2.05) / 2;
      expect(practiceOf(space, other.entityId)).toBeCloseTo((PRACTICE.raise * (1 + together)) / COMBAT.raise.seconds, 9);
      expect(practiceOf(space, healer.entityId)).toBeCloseTo((PRACTICE.raise * (1.05 + together)) / COMBAT.raise.seconds, 9);
    });

    /** Twenty steps together are a second of the other's, so the healer held the other five of six. */
    it.each<[string, (space: Arena['space'], otherId: string) => void, number | undefined]>([
      ['who dropped out and stayed earns their share', (space, otherId) => space.handleTend(undefined, otherId), 10 / 6],
      ['who left before the end earns nothing, and the rest is not scaled up', (space, otherId) => space.detach(otherId, true), undefined],
    ])('pays each Heiler their seconds held: one %s', (_label, act, otherPractice) => {
      const field = arena({}, { ghost: false });
      const { space, steps } = field;
      const { healer, target } = pair(space, STUDYING);
      const other = heiler(space, BESIDE_TARGET[0]!, 'other', STUDYING);
      space.handleTend(target.entityId, healer.entityId);
      space.handleTend(target.entityId, other.entityId);
      steps(20);
      act(space, other.entityId);
      stepsUntilRaised(field, target.entityId);
      expect(practiceOf(space, healer.entityId)).toBeCloseTo(50 / 6, 9);
      if (otherPractice !== undefined) expect(practiceOf(space, other.entityId)).toBeCloseTo(otherPractice, 9);
    });
  });
});
