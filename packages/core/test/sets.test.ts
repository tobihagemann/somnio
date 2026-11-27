import type { EquipSlot, Role } from '@somnio/protocol';
import { describe, expect, it } from 'vitest';
import type { BaseItemId, Equipment, Item } from '../src/items.ts';
import { NO_SET_BONUSES, SET_BONUSES, setBonusesOf, setPieces, shownSetPieces } from '../src/sets.ts';
import type { SetStep } from '../src/sets.ts';
import { common } from './support/items.ts';

/** Every slot an armour or jewellery piece is worn in, with a base worn there. */
const ARMOUR_SLOTS: readonly [EquipSlot, BaseItemId][] = [
  ['head', 'cap'],
  ['shoulders', 'shoulders'],
  ['chest', 'tunic'],
  ['hands', 'gloves'],
  ['legs', 'trousers'],
  ['feet', 'boots'],
  ['neck', 'amulet'],
  ['bracelet1', 'bracelet'],
  ['bracelet2', 'bracelet'],
];

const piece = (baseId: BaseItemId, line: Role): Item => ({ baseId, tier: 3, rarity: 'epic', affixes: [], line });

/** The first `count` armour and jewellery slots wearing a piece of the line's set, and the hands holding neutral items. */
const wearing = (count: number, line: Role): Equipment => ({
  mainHand: common('sword'),
  offHand: common('wand'),
  ...Object.fromEntries(ARMOUR_SLOTS.slice(0, count).map(([slot, baseId]) => [slot, piece(baseId, line)])),
});

describe('setPieces', () => {
  it("counts only the line's pieces worn", () => {
    const equipment: Equipment = { ...wearing(3, 'healer'), legs: piece('trousers', 'mystic'), feet: common('boots') };
    expect(setPieces(equipment, 'healer')).toBe(3);
    expect(setPieces(equipment, 'mystic')).toBe(1);
    expect(setPieces(equipment, 'fighter')).toBe(0);
  });

  it('counts nothing for no line, whatever neutral items are worn', () => {
    expect(setPieces({ ...wearing(0, 'healer'), head: common('cap'), feet: common('boots') }, undefined)).toBe(0);
  });

  it('counts a piece in every armour and jewellery slot', () => {
    expect(setPieces(wearing(9, 'fighter'), 'fighter')).toBe(9);
  });
});

describe('shownSetPieces', () => {
  it('counts as setPieces does up to six, the pieces a title counts to', () => {
    expect([3, 6, 9].map((count) => shownSetPieces(wearing(count, 'mystic'), 'mystic'))).toEqual([3, 6, 6]);
  });
});

describe('setBonusesOf', () => {
  it.each(['fighter', 'healer', 'mystic'] as const)('reaches each step of the %s set at 2, 4, and 6 pieces and holds at 9', (role) => {
    const [two, four, six] = SET_BONUSES[role] as [SetStep, SetStep, SetStep];
    const reached = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((count) => setBonusesOf(wearing(count, role), role));
    const after = (...steps: SetStep[]) => steps.reduce((bonuses, step) => ({ ...bonuses, ...step.sets }), NO_SET_BONUSES);
    expect(new Set([NO_SET_BONUSES, after(two), after(two, four), after(two, four, six)].map((bonuses) => JSON.stringify(bonuses))).size).toBe(4);
    expect(reached).toEqual([
      NO_SET_BONUSES,
      NO_SET_BONUSES,
      after(two),
      after(two),
      after(two, four),
      after(two, four),
      after(two, four, six),
      after(two, four, six),
      after(two, four, six),
      after(two, four, six),
    ]);
  });

  it("gives nothing for another role's pieces or for no role", () => {
    expect(setBonusesOf(wearing(6, 'healer'), 'mystic')).toEqual(NO_SET_BONUSES);
    expect(setBonusesOf(wearing(6, 'healer'), undefined)).toEqual(NO_SET_BONUSES);
  });
});
