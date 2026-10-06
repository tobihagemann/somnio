import { describe, expect, it } from 'vitest';
import { COMBAT } from '@somnio/core';
import type { Character, InventoryRow, Point } from '@somnio/core';
import type { Energy } from '@somnio/protocol';
import { BESIDE_GHOST, CUDGEL_IN_HAND, GHOST, MONDSTEIN_IN_HAND, arena, characterOf, energy, energyOf, lucidity, payloads } from './support/combat.ts';
import { collectMessages } from './support/frames.ts';
import { attachPlayer } from './support/sectorFactory.ts';

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
  ])('does nothing %s', (_label, healerCharacter, inventory, targetEnergy) => {
    const { space, steps } = arena({}, { ghost: false });
    const { healer, target } = pair(space, healerCharacter, { energy: energy({ healthCurrent: 50, ...targetEnergy }) }, inventory);
    const before = [energyOf(space, healer.entityId), energyOf(space, target.entityId)];
    space.handleTend(target.entityId, healer.entityId);
    steps(1);
    expect([energyOf(space, healer.entityId), energyOf(space, target.entityId)]).toEqual(before);
  });

  it("does not reach a dreamer beyond a body's contact and the reach slack", () => {
    const { space, steps } = arena({}, { ghost: false });
    const healer = attachPlayer(space, HEALER_AT, 'healer', { character: HEALER, inventory: [MONDSTEIN_IN_HAND] });
    const target = attachPlayer(space, { x: 5, z: 5.9 }, 'target', { character: { energy: energy({ healthCurrent: 50 }) } });
    space.handleTend(target.entityId, healer.entityId);
    steps(1);
    expect(energyOf(space, target.entityId).healthCurrent).toBe(50);
  });

  it('mends the holder who uses the Mondstein in hand, for the same spirit', () => {
    const { space } = arena({}, { ghost: false });
    const hurt = { ...HEALER, energy: energy({ healthCurrent: 50 }) };
    const healer = attachPlayer(space, HEALER_AT, 'healer', { character: hurt, inventory: [MONDSTEIN_IN_HAND] });
    space.handleUseItem(MONDSTEIN_IN_HAND.slot, healer.entityId);
    expect(energyOf(space, healer.entityId)).toMatchObject({ healthCurrent: 60, spiritCurrent: 92 });
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

    const raising = { healerId: healer.entityId, targetId: target.entityId };
    // The Mondstein reaches the dreamer again on every step, and begins nothing more.
    expect(payloads(await collectMessages(target.outbox), 'raising')).toEqual([
      { ...raising, state: 'begun', seconds: 6 },
      { ...raising, state: 'done', seconds: 0 },
    ]);
    const spirit = payloads(await collectMessages(healer.outbox), 'energy').map((sent) => sent.spiritCurrent);
    expect(spirit.every(Number.isInteger)).toBe(true);
    // Each frame has one cause, so the falls are the raise's charges and the rises are recovery.
    const charged = spirit.reduce((sum, value, index) => sum + Math.max(0, (spirit[index - 1] ?? 100) - value), 0);
    expect(charged).toBe(COMBAT.raise.spiritCost);
  });

  it('breaks off when the Heiler steps out of reach, and leaves the dreamer fallen to start over', async () => {
    const { space, steps } = arena({}, { ghost: false });
    const { healer, target } = pair(space);
    space.handleTend(target.entityId, healer.entityId);
    steps(60);
    space.handleMove({ x: 5, z: 4.7, facing: 0, gait: 'jog' }, healer.entityId);
    steps(100);
    expect(space.isFallen(target.entityId)).toBe(true);
    const raising = { healerId: healer.entityId, targetId: target.entityId };
    expect(payloads(await collectMessages(target.outbox), 'raising')).toEqual([
      { ...raising, state: 'begun', seconds: 6 },
      { ...raising, state: 'broken', seconds: 0 },
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
    expect(payloads(await collectMessages(target.outbox), 'raising').map((sent) => sent.state)).toEqual(['begun', 'broken']);
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
    expect(payloads(await collectMessages(target.outbox), 'raising').map((sent) => sent.state)).toEqual(['begun', 'broken']);
  });

  it('ends with exactly one broken, on the following step, when the Heiler falls, who is corrected to where they stood', async () => {
    const { space, steps } = arena();
    const healer = attachPlayer(space, BESIDE_GHOST, 'healer', {
      character: { ...HEALER, energy: energy({ healthCurrent: 9 }) },
      inventory: [MONDSTEIN_IN_HAND],
    });
    const target = attachPlayer(space, { x: 10.6, z: 10.7 }, 'target', { character: FALLEN });
    space.handleTend(target.entityId, healer.entityId);
    steps(1);
    expect(space.isFallen(healer.entityId)).toBe(true);
    steps(21);
    const messages = await collectMessages(target.outbox);
    expect(payloads(messages, 'raising').map((raising) => raising.state)).toEqual(['begun', 'broken']);
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
    const healer = attachPlayer(space, BESIDE_GHOST, 'healer', {
      character: { ...HEALER, energy: energy({ healthCurrent: 9 }) },
      inventory: [MONDSTEIN_IN_HAND],
    });
    const hurt = attachPlayer(space, { x: 10.6, z: 10.7 }, 'hurt', { character: { energy: energy({ healthCurrent: 50 }) } });
    space.handleTend(hurt.entityId, healer.entityId);
    steps(1);
    expect(space.isFallen(healer.entityId)).toBe(true);
    expect(energyOf(space, hurt.entityId).healthCurrent).toBe(60);
    dice.hit = false;
    space.handleTend(hurt.entityId, healer.entityId);

    const rescuer = attachPlayer(space, { x: 9.4, z: 10.7 }, 'rescuer', { character: HEALER, inventory: [MONDSTEIN_IN_HAND] });
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
    const healer = attachPlayer(space, { x: 10, z: 11.4 }, 'healer', { character: HEALER, inventory: [MONDSTEIN_IN_HAND] });
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
});
