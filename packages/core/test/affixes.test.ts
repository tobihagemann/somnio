import { RARITIES } from '@somnio/protocol';
import { describe, expect, it } from 'vitest';
import { AFFIXES, affix, rollItem } from '../src/affixes.ts';
import type { AffixId } from '../src/affixes.ts';
import { hashString, seededSequence } from '../src/hash.ts';
import { BASE_ITEMS, baseItem } from '../src/items.ts';
import type { BaseItemId, Item } from '../src/items.ts';

const ROLLED_BASES = (Object.keys(BASE_ITEMS) as BaseItemId[]).filter((baseId) => baseItem(baseId).trialOnly !== true);
const AFFIX_IDS = Object.keys(AFFIXES) as AffixId[];
const SAMPLES_PER_BASE = 200;

/** Every rarity of every base that rolls, rolled at tier 1 from one seed. */
function sample(): Item[] {
  const random = seededSequence(hashString('affixes'));
  return ROLLED_BASES.flatMap((baseId) => RARITIES.flatMap((rarity) => Array.from({ length: SAMPLES_PER_BASE }, () => rollItem(baseId, 1, rarity, random))));
}

describe('rollItem', () => {
  const items = sample();

  it('rolls no affix on a plain item, one or two on a magic one, and three or four on a rare one, each count turning up', () => {
    const counts = (rarity: Item['rarity']) => new Set(items.filter((item) => item.rarity === rarity).map((item) => item.affixes.length));
    expect([counts('plain'), counts('magic'), counts('rare')]).toEqual([new Set([0]), new Set([1, 2]), new Set([3, 4])]);
  });

  it("keeps each item's base and tier", () => {
    expect(new Set(items.map((item) => item.baseId))).toEqual(new Set(ROLLED_BASES));
    expect(items.every((item) => item.tier === 1)).toBe(true);
  });

  it('rolls no affix twice on one item', () => {
    for (const item of items) expect(new Set(item.affixes.map((rolled) => rolled.affixId)).size).toBe(item.affixes.length);
  });

  it('offers every kind of slot at least the four affixes a rare rolls', () => {
    for (const baseId of ROLLED_BASES) {
      expect(AFFIX_IDS.filter((affixId) => affix(affixId).slots.includes(baseItem(baseId).slot)).length, baseId).toBeGreaterThanOrEqual(4);
    }
  });

  it("rolls only affixes allowed on the item's slot", () => {
    for (const item of items) {
      for (const rolled of item.affixes) expect(affix(rolled.affixId).slots).toContain(baseItem(item.baseId).slot);
    }
  });

  it("rolls every value within its tier's range, both ends included", () => {
    const seen = new Map<AffixId, Set<number>>();
    for (const item of items) {
      for (const { affixId, value } of item.affixes) {
        const [least, most] = affix(affixId).tiers[1]!;
        expect(Number.isInteger(value) && value >= least && value <= most, `${affixId} ${value}`).toBe(true);
        seen.set(affixId, (seen.get(affixId) ?? new Set()).add(value));
      }
    }
    for (const [affixId, values] of seen) {
      const [least, most] = affix(affixId).tiers[1]!;
      expect([values.has(least), values.has(most)], affixId).toEqual([true, true]);
    }
  });

  it('never rolls the Moonstone', () => {
    expect(() => rollItem('moonstone', 1, 'plain', seededSequence(1))).toThrow();
  });
});
