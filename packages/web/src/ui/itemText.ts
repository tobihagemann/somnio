import { affix, baseItem } from '@somnio/core';
import type { EquipSlot, Item, Rarity, SlotKind, StatId } from '@somnio/core';
import { itemName, t } from '@/i18n';
import type { Tip } from './hudTooltip';

/** Thunks rather than constants so `t` runs after the locale resolves, each key in a literal `t('...')` the catalog test can find. */
const RARITY_NAMES: Record<Rarity, () => string> = {
  plain: () => t('Plain'),
  magic: () => t('Magic'),
  rare: () => t('Rare'),
};

/** Each slot's name on the doll, and each kind of slot's in an item's tip, where a ring fits either ring slot. */
const SLOT_NAMES: Record<EquipSlot | SlotKind, () => string> = {
  mainHand: () => t('Main hand'),
  offHand: () => t('Off hand'),
  head: () => t('Head'),
  chest: () => t('Chest'),
  hands: () => t('Hands'),
  legs: () => t('Legs'),
  feet: () => t('Feet'),
  neck: () => t('Neck'),
  ring: () => t('Ring'),
  ring1: () => t('Ring 1'),
  ring2: () => t('Ring 2'),
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
 * What an item does, a line each: a weapon's swing or what the off hand's tools allow, then what
 * every item of its base carries, then each stat line it rolled.
 */
export function itemLines(item: Item): string[] {
  const { weapon, implicit = {}, focus } = baseItem(item.baseId);
  return [
    ...(weapon === undefined ? [] : [t('%1$@ damage, %2$@ balance a swing', String(weapon.damage), String(weapon.balanceCost))]),
    ...(item.baseId === 'moonstone' ? [t('In the off hand, it lets a Healer mend and use their abilities.')] : []),
    ...(focus === true ? [t('In the off hand, it lets a Mystic use their abilities.')] : []),
    ...(Object.keys(implicit) as StatId[]).map((stat) => statLine(stat, implicit[stat]!)),
    ...item.affixes.map(({ affixId, value }) => statLine(affix(affixId).stat, value)),
  ];
}

/** What an item's tip says: its icon, its name in its rarity's colour, its rarity and slot, what it does, and anything after that. */
export function itemTip(item: Item, after: { lines?: readonly string[]; warning?: string } = {}): Tip {
  return {
    title: itemName(item.baseId, t),
    rarity: item.rarity,
    icon: item.baseId,
    facts: [{ text: rarityName(item.rarity) }, { text: slotName(baseItem(item.baseId).slot) }],
    lines: [...itemLines(item), ...(after.lines ?? [])],
    ...(after.warning === undefined ? {} : { warning: after.warning }),
  };
}
