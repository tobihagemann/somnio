import { EQUIP_SLOTS, RARITIES } from '@somnio/protocol';
import type { EquipSlot, Rarity } from '@somnio/protocol';
import type { AffixId } from './affixes.ts';

export type { EquipSlot, Rarity };

export function isEquipSlot(value: string): value is EquipSlot {
  return (EQUIP_SLOTS as readonly string[]).includes(value);
}

export function isRarity(value: string): value is Rarity {
  return (RARITIES as readonly string[]).includes(value);
}

/** How far from Edaria an item comes from, the bestiary's rings: a further ring rolls higher. */
export type Tier = 1 | 2 | 3 | 4 | 5;

export function isTier(value: number): value is Tier {
  return Number.isInteger(value) && value >= 1 && value <= 5;
}

/**
 * What a dreamer's gear and ranks add to the rules, as whole numbers. A share is in percent.
 */
export interface Stats {
  /** Added to each pool's maximum. */
  healthMax: number;
  balanceMax: number;
  spiritMax: number;
  /** Added to each swing's damage. */
  damage: number;
  /** Each point takes a hundredth off a nightmare's chance to land a strike. */
  guard: number;
  /** The share taken off the pause between swings. */
  swingSpeed: number;
  /** The share added to each pool's recovery. */
  balanceRecovery: number;
  spiritRecovery: number;
  /** Added to the health each mend gives. */
  mendDepth: number;
  /** The share added to the shield a ward puts up. */
  wardStrength: number;
}
export type StatId = keyof Stats;

/** The stats of a dreamer with no ranks and nothing worn. */
export const NO_STATS: Stats = {
  healthMax: 0,
  balanceMax: 0,
  spiritMax: 0,
  damage: 0,
  guard: 0,
  swingSpeed: 0,
  balanceRecovery: 0,
  spiritRecovery: 0,
  mendDepth: 0,
  wardStrength: 0,
};

export interface Weapon {
  damage: number;
  /** The balance one swing costs. */
  balanceCost: number;
}

/** The kind of slot a base fits: a slot of its own, or `ring`, which fits either ring slot. */
export type SlotKind = Exclude<EquipSlot, 'ring1' | 'ring2'> | 'ring';

interface BaseItem {
  labelKey: string;
  slot: SlotKind;
  tier: Tier;
  /** What a weapon in the main hand swings as. */
  weapon?: Weapon;
  /** The stats every item of the base carries before its affixes. */
  implicit?: Partial<Stats>;
  /** A Mystic's focus, which their kit needs in the off hand. */
  focus?: true;
  /** It comes only from the Healer's trial: it is never rolled, dropped, bought, or sold. */
  trialOnly?: true;
}

/**
 * The kinds of item there are, by id, each with the catalog key of its display name. An id is
 * saved with every item, so it is kebab-case like a teaching id.
 */
export const BASE_ITEMS = {
  dagger: { labelKey: 'Dagger', slot: 'mainHand', tier: 1, weapon: { damage: 6, balanceCost: 10 } },
  cudgel: { labelKey: 'Cudgel', slot: 'mainHand', tier: 1, weapon: { damage: 8, balanceCost: 18 } },
  sword: { labelKey: 'Short sword', slot: 'mainHand', tier: 1, weapon: { damage: 11, balanceCost: 24 } },
  mace: { labelKey: 'Mace', slot: 'mainHand', tier: 1, weapon: { damage: 14, balanceCost: 32 } },
  buckler: { labelKey: 'Buckler', slot: 'offHand', tier: 1, implicit: { guard: 2 } },
  shield: { labelKey: 'Round shield', slot: 'offHand', tier: 1, implicit: { guard: 4 } },
  /** The Healer's tool. In the off hand it lets Mend mend the target and the Healer use their abilities. */
  moonstone: { labelKey: 'Moonstone', slot: 'offHand', tier: 1, trialOnly: true },
  wand: { labelKey: 'Wand', slot: 'offHand', tier: 1, focus: true },
  cap: { labelKey: 'Leather cap', slot: 'head', tier: 1, implicit: { guard: 1 } },
  tunic: { labelKey: 'Padded tunic', slot: 'chest', tier: 1, implicit: { guard: 3 } },
  gloves: { labelKey: 'Leather gloves', slot: 'hands', tier: 1, implicit: { guard: 1 } },
  trousers: { labelKey: 'Leather trousers', slot: 'legs', tier: 1, implicit: { guard: 2 } },
  boots: { labelKey: 'Leather boots', slot: 'feet', tier: 1, implicit: { guard: 1 } },
  amulet: { labelKey: 'Amulet', slot: 'neck', tier: 1, implicit: { healthMax: 5 } },
  ring: { labelKey: 'Iron ring', slot: 'ring', tier: 1, implicit: { healthMax: 2 } },
} as const satisfies Record<string, BaseItem>;
export type BaseItemId = keyof typeof BASE_ITEMS;

export function isBaseItemId(value: string): value is BaseItemId {
  return Object.hasOwn(BASE_ITEMS, value);
}

export function baseItem(baseId: BaseItemId): BaseItem {
  return BASE_ITEMS[baseId];
}

const RING_SLOTS = ['ring1', 'ring2'] as const satisfies readonly EquipSlot[];

/** The slots an item of the base is worn in, in the order one is taken: a ring's two, any other base's one. */
export function slotsFor(baseId: BaseItemId): readonly EquipSlot[] {
  const kind = baseItem(baseId).slot;
  return kind === 'ring' ? RING_SLOTS : [kind];
}

/** One stat line an item rolled, and how much it adds. */
export interface RolledAffix {
  affixId: AffixId;
  value: number;
}

/** One item as a dreamer has it: its base, the tier it rolled at, and the stat lines its rarity gave it. */
export interface Item {
  baseId: BaseItemId;
  tier: Tier;
  rarity: Rarity;
  affixes: readonly RolledAffix[];
}

/** An item a dreamer has, named by an id of its own while they keep it. */
export interface ItemInstance extends Item {
  id: string;
}

/**
 * A new item id: a UUIDv7, whose leading 48 bits are the milliseconds it was made at, so a
 * dreamer's items sort by id in the order they came by them.
 */
export function newItemId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let ms = Date.now();
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A plain item of the base, at the base's tier: what Mercus sells and a trial gives. */
export function plainItem(baseId: BaseItemId): Item {
  return { baseId, tier: baseItem(baseId).tier, rarity: 'plain', affixes: [] };
}

/** A plain item of the base, at the base's tier, under a new id. */
export function plainInstance(baseId: BaseItemId): ItemInstance {
  return { id: newItemId(), ...plainItem(baseId) };
}

/** What a dreamer wears, by slot. */
export type Equipment = Partial<Record<EquipSlot, Item>>;

/** The slot an item of the base is worn in when equipped: the first of its slots that is empty, else the first, whose item it replaces. */
export function equipSlot(equipment: Equipment, baseId: BaseItemId): EquipSlot {
  const slots = slotsFor(baseId);
  return slots.find((slot) => equipment[slot] === undefined) ?? slots[0]!;
}

/** What a dreamer holds in their two hands, which is what slot 1 and the abilities read. */
export type Hands = Pick<Equipment, 'mainHand' | 'offHand'>;

/**
 * The catalog key of an item's display name, which the consumer resolves in its locale. An unknown
 * id resolves to `undefined` so a missing entry surfaces rather than rendering a wrong label.
 */
export function itemLabelKey(baseId: string): string | undefined {
  return isBaseItemId(baseId) ? baseItem(baseId).labelKey : undefined;
}
