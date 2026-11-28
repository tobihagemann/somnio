import { ROLES } from '@somnio/protocol';
import { describe, expect, it } from 'vitest';
import { AFFIXES, affix, itemNameKeys, rollItem, rollSetPiece } from '../src/affixes.ts';
import type { AffixId } from '../src/affixes.ts';
import { hashString, seededSequence } from '../src/hash.ts';
import { BASE_ITEMS, NEUTRAL_RARITIES, baseItem, isWardrobeBase } from '../src/items.ts';
import type { BaseItemId, Item, Tier } from '../src/items.ts';

const ROLLED_BASES = (Object.keys(BASE_ITEMS) as BaseItemId[]).filter((baseId) => baseItem(baseId).trialOnly !== true);
const AFFIX_IDS = Object.keys(AFFIXES) as AffixId[];
const SAMPLES_PER_BASE = 200;

/** The tiers nightmares drop. */
const DROPPED_TIERS = [1, 2, 3] as const satisfies readonly Tier[];

/** Every rarity a roll gives of every base that rolls, rolled at the tier from one seed. */
function sample(tier: Tier): Item[] {
  const random = seededSequence(hashString(`affixes ${tier}`));
  return ROLLED_BASES.flatMap((baseId) =>
    NEUTRAL_RARITIES.flatMap((rarity) => Array.from({ length: SAMPLES_PER_BASE }, () => rollItem(baseId, tier, rarity, random))),
  );
}

describe.each(DROPPED_TIERS)('rollItem at tier %i', (tier) => {
  const items = sample(tier);

  it('rolls no affix on a common item, one or two on an uncommon one, and three or four on a rare one, each count turning up', () => {
    const counts = (rarity: Item['rarity']) => new Set(items.filter((item) => item.rarity === rarity).map((item) => item.affixes.length));
    expect([counts('common'), counts('uncommon'), counts('rare')]).toEqual([new Set([0]), new Set([1, 2]), new Set([3, 4])]);
  });

  it("keeps each item's base and tier", () => {
    expect(new Set(items.map((item) => item.baseId))).toEqual(new Set(ROLLED_BASES));
    expect(items.every((item) => item.tier === tier)).toBe(true);
  });

  it('rolls no affix twice on one item', () => {
    for (const item of items) expect(new Set(item.affixes.map((rolled) => rolled.affixId)).size).toBe(item.affixes.length);
  });

  it('offers every kind of slot at least the four affixes a rare rolls', () => {
    for (const baseId of ROLLED_BASES) {
      const offered = AFFIX_IDS.filter((affixId) => affix(affixId).slots.includes(baseItem(baseId).slot) && affix(affixId).tiers[tier] !== undefined);
      expect(offered.length, baseId).toBeGreaterThanOrEqual(4);
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
        const [least, most] = affix(affixId).tiers[tier]!;
        expect(Number.isInteger(value) && value >= least && value <= most, `${affixId} ${value}`).toBe(true);
        seen.set(affixId, (seen.get(affixId) ?? new Set()).add(value));
      }
    }
    for (const [affixId, values] of seen) {
      const [least, most] = affix(affixId).tiers[tier]!;
      expect([values.has(least), values.has(most)], affixId).toEqual([true, true]);
    }
  });

  it('never rolls the Moonstone', () => {
    expect(() => rollItem('moonstone', tier, 'common', seededSequence(1))).toThrow();
  });
});

describe('rollSetPiece', () => {
  const random = seededSequence(hashString('set pieces'));
  const pieces = ROLLED_BASES.filter(isWardrobeBase).flatMap((baseId) =>
    ROLES.flatMap((role) => Array.from({ length: SAMPLES_PER_BASE }, () => ({ role, piece: rollSetPiece(baseId, 3, role, random) }))),
  );

  it("rolls an epic of the role's line at the tier, with four lines allowed on its slot, none twice, each within its range", () => {
    for (const { role, piece } of pieces) {
      expect([piece.tier, piece.rarity, piece.line, piece.affixes.length]).toEqual([3, 'epic', role, 4]);
      expect(new Set(piece.affixes.map((rolled) => rolled.affixId)).size).toBe(4);
      for (const { affixId, value } of piece.affixes) {
        const [least, most] = affix(affixId).tiers[3]!;
        expect(affix(affixId).slots.includes(baseItem(piece.baseId).slot) && value >= least && value <= most, `${affixId} ${value}`).toBe(true);
      }
    }
  });

  it("names a set piece by its line's design alone, without the suffix of its strongest roll", () => {
    expect(itemNameKeys(rollSetPiece('cap', 3, 'healer', seededSequence(1)))).toEqual({ labelKey: 'Linen wimple' });
  });
});

describe('AFFIXES', () => {
  it('rolls on shoulders the lines a chest rolls', () => {
    expect(AFFIX_IDS.filter((affixId) => affix(affixId).slots.includes('shoulders'))).toEqual(
      AFFIX_IDS.filter((affixId) => affix(affixId).slots.includes('chest')),
    );
  });

  it('rolls every line higher at each dropped tier than at the one before', () => {
    for (const affixId of AFFIX_IDS) {
      for (const [lower, higher] of [
        [1, 2],
        [2, 3],
      ] as const) {
        const [leastLower, mostLower] = affix(affixId).tiers[lower]!;
        const [leastHigher, mostHigher] = affix(affixId).tiers[higher]!;
        expect([leastHigher > leastLower, mostHigher > mostLower], `${affixId} ${lower}-${higher}`).toEqual([true, true]);
      }
    }
  });
});

describe('itemNameKeys', () => {
  const trousers = (tier: Tier, affixes: Item['affixes']): Item => ({ baseId: 'trousers', tier, rarity: 'uncommon', affixes });

  it('names a common item after its base alone, by its design at its tier', () => {
    expect(itemNameKeys({ baseId: 'trousers', tier: 1, rarity: 'common', affixes: [] })).toEqual({ labelKey: 'Field trousers' });
    expect(itemNameKeys({ baseId: 'trousers', tier: 3, rarity: 'common', affixes: [] })).toEqual({ labelKey: 'Wader trousers' });
  });

  it('adds the suffix of the line rolled nearest the most it rolls at the item tier', () => {
    expect(
      itemNameKeys(
        trousers(1, [
          { affixId: 'health', value: 5 },
          { affixId: 'guard', value: 2 },
        ]),
      ),
    ).toEqual({
      labelKey: 'Field trousers',
      suffixKey: '%@ of the Bulwark',
    });
    expect(
      itemNameKeys(
        trousers(3, [
          { affixId: 'health', value: 12 },
          { affixId: 'guard', value: 4 },
        ]),
      ).suffixKey,
    ).toBe('%@ of Vigour');
  });

  it('breaks a tie by the order the lines are declared in, whatever the order the item holds them in', () => {
    const health = { affixId: 'health', value: 8 } as const;
    const guard = { affixId: 'guard', value: 3 } as const;
    expect(itemNameKeys(trousers(1, [health, guard])).suffixKey).toBe('%@ of Vigour');
    expect(itemNameKeys(trousers(1, [guard, health])).suffixKey).toBe('%@ of Vigour');
  });

  it('passes over a line with no range at the item tier', () => {
    expect(itemNameKeys(trousers(4, [{ affixId: 'health', value: 8 }]))).toEqual({ labelKey: 'Trail leathers' });
  });
});
