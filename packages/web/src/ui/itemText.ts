import { NO_STATS, SET_BONUSES, SET_TITLE_KEYS, baseItem, itemNameKeys, itemStats, salePrice, sellable, shownSetPieces, swingFor } from '@somnio/core';
import type { Equipment, EquipSlot, Item, Rarity, SetStep, SlotKind, StatId } from '@somnio/core';
import type { Role } from '@somnio/protocol';
import { t } from '@/i18n';
import type { Tip } from './hudTooltip';

/** Thunks rather than constants so `t` runs after the locale resolves, each key in a literal `t('...')` the catalog test can find. */
const RARITY_NAMES: Record<Rarity, () => string> = {
  common: () => t('Common'),
  uncommon: () => t('Uncommon'),
  rare: () => t('Rare'),
  epic: () => t('Epic'),
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

/** An item's name: its base's, with the suffix of its strongest roll for an uncommon or a rare one. */
export function itemTitle(item: Item): string {
  const { labelKey, suffixKey } = itemNameKeys(item);
  const base = t(labelKey);
  return suffixKey === undefined ? base : t(suffixKey, base);
}

/** Who reads an item's tip: their role, and what they wear, which says how much of a set they have. */
export interface ItemReader {
  role: Role | undefined;
  equipped: Equipment;
}

/** Who alone can wear a piece of the line's set: the caption over a place, and the line beside it. */
export function lineRefusal(line: Role): { caption: string; notice: string } {
  switch (line) {
    case 'fighter':
      return { caption: t('Fighters only'), notice: t('Only Fighters can wear this.') };
    case 'healer':
      return { caption: t('Healers only'), notice: t('Only Healers can wear this.') };
    case 'mystic':
      return { caption: t('Mystics only'), notice: t('Only Mystics can wear this.') };
  }
}

/** A step of a set as one line, after the pieces that reach it: "(2) Renewal lasts 4 s longer." */
export function setStepLine(step: SetStep): string {
  return t('(%1$@) %2$@', String(step.pieces), t(step.textKey));
}

/**
 * What an item's tip says: its icon, its name in its rarity's colour, its rarity and slot, what it
 * does, what the shopkeeper pays for it if he buys it, and anything after that. A set piece also
 * says who alone can wear it, in red for a reader who cannot, and its set: how many of it the reader
 * wears, and each step, lit once the reader of the line wears enough for it.
 */
export function itemTip(item: Item, after: { lines?: readonly string[]; warning?: string }, reader: ItemReader): Tip {
  const line = item.line;
  const set = line === undefined ? undefined : { line, pieces: shownSetPieces(reader.equipped, line), own: reader.role === line };
  return {
    title: itemTitle(item),
    rarity: item.rarity,
    icon: item,
    facts: [
      { text: rarityName(item.rarity) },
      { text: slotName(baseItem(item.baseId).slot) },
      ...(set === undefined ? [] : [{ text: lineRefusal(set.line).caption, ...(set.own ? {} : { refused: true as const }) }]),
    ],
    lines: [
      ...itemLines(item),
      ...(set === undefined
        ? []
        : [
            { text: t(SET_TITLE_KEYS[set.line], String(set.pieces)), on: true },
            ...SET_BONUSES[set.line].map((step) => ({ text: setStepLine(step), on: set.own && set.pieces >= step.pieces })),
          ]),
      ...(sellable(item) ? [t('Sells for %@c', String(salePrice(item)))] : []),
      ...(after.lines ?? []),
    ],
    ...(after.warning === undefined ? {} : { warning: after.warning }),
  };
}
