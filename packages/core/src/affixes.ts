import type { Role } from '@somnio/protocol';
import { baseItem, isSetTier, itemLabelKey } from './items.ts';
import type { BaseItemId, Item, NeutralRarity, Rarity, RolledAffix, SlotKind, StatId, Tier, WardrobeBaseId } from './items.ts';

/** A stat line an item may roll. */
interface Affix {
  /** The stat it adds to. */
  stat: StatId;
  /** The coins each point of it adds to an item's value. */
  worth: number;
  /** The catalog key of the name of an item whose strongest roll it is, with `%@` for the base's name. */
  nameKey: string;
  /** The kinds of slot of the items it may roll on. */
  slots: readonly SlotKind[];
  /** The least and the most it adds, by the tier it rolls at. A tier left out rolls none of it. */
  tiers: Partial<Record<Tier, readonly [number, number]>>;
}

/**
 * The stat lines items roll, by id. Every kind of slot offers at least the four a rare item rolls at
 * each tier a nightmare drops, since `rollItem` refuses a count its pool cannot fill. Both bounds of
 * a line rise from each tier to the next, though neighbouring ranges may overlap. An id is saved with
 * every item that rolled it, so it is kebab-case like a teaching id. The ranges are tuned in play,
 * as `COMBAT`'s numbers are.
 */
export const AFFIXES = {
  health: {
    stat: 'healthMax',
    worth: 5,
    nameKey: '%@ of Vigour',
    slots: ['offHand', 'head', 'shoulders', 'chest', 'hands', 'legs', 'feet'],
    tiers: { 1: [3, 8], 2: [6, 13], 3: [10, 18] },
  },
  balance: {
    stat: 'balanceMax',
    worth: 5,
    nameKey: '%@ of Poise',
    slots: ['mainHand', 'head', 'shoulders', 'chest', 'hands', 'legs', 'feet'],
    tiers: { 1: [3, 8], 2: [6, 13], 3: [10, 18] },
  },
  spirit: { stat: 'spiritMax', worth: 5, nameKey: '%@ of Reverie', slots: ['offHand', 'neck', 'bracelet'], tiers: { 1: [3, 8], 2: [6, 13], 3: [10, 18] } },
  damage: { stat: 'damage', worth: 13, nameKey: '%@ of Might', slots: ['mainHand', 'hands', 'neck', 'bracelet'], tiers: { 1: [1, 3], 2: [2, 5], 3: [4, 7] } },
  guard: {
    stat: 'guard',
    worth: 13,
    nameKey: '%@ of the Bulwark',
    slots: ['offHand', 'head', 'shoulders', 'chest', 'hands', 'legs', 'feet'],
    tiers: { 1: [1, 3], 2: [2, 5], 3: [4, 7] },
  },
  'swing-speed': { stat: 'swingSpeed', worth: 5, nameKey: '%@ of Haste', slots: ['mainHand', 'hands'], tiers: { 1: [3, 8], 2: [6, 11], 3: [9, 14] } },
  'balance-recovery': {
    stat: 'balanceRecovery',
    worth: 3,
    nameKey: '%@ of Steadiness',
    slots: ['mainHand', 'head', 'shoulders', 'chest', 'legs', 'feet', 'neck', 'bracelet'],
    tiers: { 1: [5, 15], 2: [10, 22], 3: [16, 30] },
  },
  'spirit-recovery': {
    stat: 'spiritRecovery',
    worth: 3,
    nameKey: '%@ of Stillness',
    slots: ['offHand', 'neck', 'bracelet'],
    tiers: { 1: [5, 15], 2: [10, 22], 3: [16, 30] },
  },
  'mend-depth': { stat: 'mendDepth', worth: 13, nameKey: '%@ of Mending', slots: ['offHand', 'neck', 'bracelet'], tiers: { 1: [1, 3], 2: [2, 5], 3: [4, 7] } },
  'ward-strength': {
    stat: 'wardStrength',
    worth: 3,
    nameKey: '%@ of Warding',
    slots: ['offHand', 'neck', 'bracelet'],
    tiers: { 1: [5, 15], 2: [10, 22], 3: [16, 30] },
  },
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
const AFFIX_COUNTS = { common: [0, 0], uncommon: [1, 2], rare: [3, 4], epic: [4, 4] } as const satisfies Record<Rarity, readonly [number, number]>;

/** A whole number from the least to the most, both included, by a roll in `[0, 1)`. */
function rollWithin([least, most]: readonly [number, number], random: () => number): number {
  return least + Math.floor(random() * (most - least + 1));
}

/**
 * As many affixes as the rarity rolls for an item of the base at the tier, each one allowed on the
 * base's slot at that tier and none twice, each with a value in its range.
 */
function rollAffixes(baseId: BaseItemId, tier: Tier, rarity: Rarity, random: () => number): RolledAffix[] {
  const base = baseItem(baseId);
  const pool = AFFIX_IDS.filter((affixId) => affix(affixId).slots.includes(base.slot) && affix(affixId).tiers[tier] !== undefined);
  const count = rollWithin(AFFIX_COUNTS[rarity], random);
  if (count > pool.length) throw new Error(`${baseId} rolls at most ${pool.length} affixes at tier ${tier}`);
  const affixes: RolledAffix[] = [];
  for (let index = 0; index < count; index += 1) {
    const affixId = pool.splice(Math.floor(random() * pool.length), 1)[0]!;
    affixes.push({ affixId, value: rollWithin(affix(affixId).tiers[tier]!, random) });
  }
  return affixes;
}

/**
 * An item of the base rolled at the tier and rarity, with the affixes the rarity rolls. `random`
 * gives rolls in `[0, 1)`. The Moonstone is never rolled.
 */
export function rollItem(baseId: BaseItemId, tier: Tier, rarity: NeutralRarity, random: () => number): Item {
  if (baseItem(baseId).trialOnly === true) throw new Error(`${baseId} is never rolled`);
  return { baseId, tier, rarity, affixes: rollAffixes(baseId, tier, rarity, random) };
}

/**
 * A piece of the role's set of the base, rolled at the tier: epic, with the affixes an epic rolls.
 * It is the one way an epic is made, and only at a tier of `SET_TIERS`, the tiers its designs exist at.
 * `random` gives rolls in `[0, 1)`.
 */
export function rollSetPiece(baseId: WardrobeBaseId, tier: Tier, role: Role, random: () => number): Item {
  if (!isSetTier(tier)) throw new Error(`no set piece is made at tier ${tier}`);
  return { baseId, tier, rarity: 'epic', affixes: rollAffixes(baseId, tier, 'epic', random), line: role };
}

/**
 * The line an item rolled highest: the largest share of the most its affix rolls at the item's
 * tier. A line with no range at that tier does not count. Of two as high, the one `AFFIXES` lists
 * first wins, so the order of the item's lines changes nothing.
 */
function strongestRoll(item: Item): RolledAffix | undefined {
  let strongest: { line: RolledAffix; most: number } | undefined;
  for (const line of item.affixes) {
    const most = affix(line.affixId).tiers[item.tier]?.[1];
    if (most === undefined) continue;
    if (strongest !== undefined) {
      const ahead = line.value * strongest.most - strongest.line.value * most;
      if (ahead < 0 || (ahead === 0 && AFFIX_IDS.indexOf(line.affixId) > AFFIX_IDS.indexOf(strongest.line.affixId))) continue;
    }
    strongest = { line, most };
  }
  return strongest?.line;
}

/** The catalog keys of an item's name: its base's at its tier in its line, and the suffix of its strongest roll when it has one. An epic takes no suffix, since it goes by its design alone. */
export function itemNameKeys(item: Item): { labelKey: string; suffixKey?: string } {
  const labelKey = itemLabelKey(item.baseId, item.tier, item.line);
  const strongest = item.rarity === 'epic' ? undefined : strongestRoll(item);
  return strongest === undefined ? { labelKey } : { labelKey, suffixKey: affix(strongest.affixId).nameKey };
}
