import { NO_STATS, baseItem, itemNameKeys, itemStats, salePrice, sellable, swingFor } from '@somnio/core';
import type { EquipSlot, Item, Rarity, SlotKind, StatId } from '@somnio/core';
import { t } from '@/i18n';
import type { Tip } from './hudTooltip';

/** Thunks rather than constants so `t` runs after the locale resolves, each key in a literal `t('...')` the catalog test can find. */
const RARITY_NAMES: Record<Rarity, () => string> = {
  plain: () => t('Plain'),
  magic: () => t('Magic'),
  rare: () => t('Rare'),
};

/** Each slot's name on the doll, and each kind of slot's in an item's tip, where a bracelet fits either bracelet slot. */
const SLOT_NAMES: Record<EquipSlot | SlotKind, () => string> = {
  mainHand: () => t('Main hand'),
  offHand: () => t('Off hand'),
  head: () => t('Head'),
  shoulders: () => t('Shoulders'),
  chest: () => t('Chest'),
  hands: () => t('Hands'),
  legs: () => t('Legs'),
  feet: () => t('Feet'),
  neck: () => t('Neck'),
  bracelet: () => t('Bracelet'),
  bracelet1: () => t('Bracelet 1'),
  bracelet2: () => t('Bracelet 2'),
};

const STAT_LINES: Record<StatId, (value: string) => string> = {
  healthMax: (value) => t('+%@ Health', value),
  balanceMax: (value) => t('+%@ Balance', value),
  spiritMax: (value) => t('+%@ Spirit', value),
  damage: (value) => t('+%@ damage', value),
  guard: (value) => t('+%@ Guard', value),
  swingSpeed: (value) => t('+%@%% swing speed', value),
  balanceRecovery: (value) => t('+%@%% Balance recovery', value),
  spiritRecovery: (value) => t('+%@%% Spirit recovery', value),
  mendDepth: (value) => t('+%@ health a mend', value),
  wardStrength: (value) => t('+%@%% ward strength', value),
};

export function rarityName(rarity: Rarity): string {
  return RARITY_NAMES[rarity]();
}

export function slotName(slot: EquipSlot | SlotKind): string {
  return SLOT_NAMES[slot]();
}

/** What a stat adds, as one line. */
export function statLine(stat: StatId, value: number): string {
  return STAT_LINES[stat](String(value));
}

/**
 * What an item does, a line each: a weapon's swing, its rolled damage with it, or what the off
 * hand's tools allow, then one total for each stat its base and its rolled lines add to.
 */
export function itemLines(item: Item): string[] {
  const totals = itemStats(item);
  const swing = swingFor(item, totals);
  const stats = (Object.keys(NO_STATS) as StatId[]).filter((stat) => totals[stat] !== 0 && !(swing !== undefined && stat === 'damage'));
  return [
    ...(swing === undefined ? [] : [t('%1$@ damage, %2$@ balance a swing', String(swing.damage), String(swing.balanceCost))]),
    ...(item.baseId === 'moonstone' ? [t('In the off hand, it lets a Healer mend and use their abilities.')] : []),
    ...(baseItem(item.baseId).focus === true ? [t('In the off hand, it lets a Mystic use their abilities.')] : []),
    ...stats.map((stat) => statLine(stat, totals[stat])),
  ];
}

/** An item's name: its base's, with the suffix of its strongest roll for a magic or a rare one. */
export function itemTitle(item: Item): string {
  const { labelKey, suffixKey } = itemNameKeys(item);
  const base = t(labelKey);
  return suffixKey === undefined ? base : t(suffixKey, base);
}

/**
 * What an item's tip says: its icon, its name in its rarity's colour, its rarity and slot, what it
 * does, what the shopkeeper pays for it if he buys it, and anything after that.
 */
export function itemTip(item: Item, after: { lines?: readonly string[]; warning?: string } = {}): Tip {
  return {
    title: itemTitle(item),
    rarity: item.rarity,
    icon: item,
    facts: [{ text: rarityName(item.rarity) }, { text: slotName(baseItem(item.baseId).slot) }],
    lines: [...itemLines(item), ...(sellable(item) ? [t('Sells for %@c', String(salePrice(item)))] : []), ...(after.lines ?? [])],
    ...(after.warning === undefined ? {} : { warning: after.warning }),
  };
}
