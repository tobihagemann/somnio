import { baseItem } from './items.ts';
import type { BaseItemId, Item, Rarity, RolledAffix, SlotKind, StatId, Tier } from './items.ts';

/** A stat line an item may roll. */
interface Affix {
  /** The stat it adds to. */
  stat: StatId;
  /** The kinds of slot of the items it may roll on. */
  slots: readonly SlotKind[];
  /** The least and the most it adds, by the tier it rolls at. A tier left out rolls none of it. */
  tiers: Partial<Record<Tier, readonly [number, number]>>;
}

/**
 * The stat lines items roll, by id. Every kind of slot offers at least the four a rare item rolls,
 * since `rollItem` refuses a count its pool cannot fill. An id is saved with every item that rolled
 * it, so it is kebab-case like a teaching id. The ranges are tuned in play, as `COMBAT`'s numbers are.
 */
export const AFFIXES = {
  health: { stat: 'healthMax', slots: ['offHand', 'head', 'chest', 'hands', 'legs', 'feet'], tiers: { 1: [3, 8] } },
  balance: { stat: 'balanceMax', slots: ['mainHand', 'head', 'chest', 'hands', 'legs', 'feet'], tiers: { 1: [3, 8] } },
  spirit: { stat: 'spiritMax', slots: ['offHand', 'neck', 'ring'], tiers: { 1: [3, 8] } },
  damage: { stat: 'damage', slots: ['mainHand', 'hands', 'neck', 'ring'], tiers: { 1: [1, 3] } },
  guard: { stat: 'guard', slots: ['offHand', 'head', 'chest', 'hands', 'legs', 'feet'], tiers: { 1: [1, 3] } },
  'swing-speed': { stat: 'swingSpeed', slots: ['mainHand', 'hands'], tiers: { 1: [3, 8] } },
  'balance-recovery': { stat: 'balanceRecovery', slots: ['mainHand', 'head', 'chest', 'legs', 'feet', 'neck', 'ring'], tiers: { 1: [5, 15] } },
  'spirit-recovery': { stat: 'spiritRecovery', slots: ['offHand', 'neck', 'ring'], tiers: { 1: [5, 15] } },
  'mend-depth': { stat: 'mendDepth', slots: ['offHand', 'neck', 'ring'], tiers: { 1: [1, 3] } },
  'ward-strength': { stat: 'wardStrength', slots: ['offHand', 'neck', 'ring'], tiers: { 1: [5, 15] } },
} as const satisfies Record<string, Affix>;
export type AffixId = keyof typeof AFFIXES;

const AFFIX_IDS = Object.keys(AFFIXES) as AffixId[];

export function isAffixId(value: string): value is AffixId {
  return Object.hasOwn(AFFIXES, value);
}

export function affix(affixId: AffixId): Affix {
  return AFFIXES[affixId];
}

/** The fewest and the most affixes an item of each rarity rolls. */
const AFFIX_COUNTS = { plain: [0, 0], magic: [1, 2], rare: [3, 4] } as const satisfies Record<Rarity, readonly [number, number]>;

/** A whole number from the least to the most, both included, by a roll in `[0, 1)`. */
function rollWithin([least, most]: readonly [number, number], random: () => number): number {
  return least + Math.floor(random() * (most - least + 1));
}

/**
 * An item of the base rolled at the tier and rarity: as many affixes as the rarity rolls, each one
 * allowed on the base's slot at that tier and none twice, each with a value in its range. `random`
 * gives rolls in `[0, 1)`. The Moonstone is never rolled.
 */
export function rollItem(baseId: BaseItemId, tier: Tier, rarity: Rarity, random: () => number): Item {
  const base = baseItem(baseId);
  if (base.trialOnly === true) throw new Error(`${baseId} is never rolled`);
  const pool = AFFIX_IDS.filter((affixId) => affix(affixId).slots.includes(base.slot) && affix(affixId).tiers[tier] !== undefined);
  const count = rollWithin(AFFIX_COUNTS[rarity], random);
  if (count > pool.length) throw new Error(`${baseId} rolls at most ${pool.length} affixes at tier ${tier}`);
  const affixes: RolledAffix[] = [];
  for (let index = 0; index < count; index += 1) {
    const affixId = pool.splice(Math.floor(random() * pool.length), 1)[0]!;
    affixes.push({ affixId, value: rollWithin(affix(affixId).tiers[tier]!, random) });
  }
  return { baseId, tier, rarity, affixes };
}
