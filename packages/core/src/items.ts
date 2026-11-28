import { EQUIP_SLOTS, RARITIES } from '@somnio/protocol';
import type { EquipSlot, Hand, Rarity, Role } from '@somnio/protocol';
import type { AffixId } from './affixes.ts';

export type { EquipSlot, Rarity };

export function isEquipSlot(value: string): value is EquipSlot {
  return (EQUIP_SLOTS as readonly string[]).includes(value);
}

export function isRarity(value: string): value is Rarity {
  return (RARITIES as readonly string[]).includes(value);
}

/** The rarities an ordinary roll gives: every one but epic, which only a set piece is. */
export const NEUTRAL_RARITIES = ['common', 'uncommon', 'rare'] as const satisfies readonly Rarity[];
export type NeutralRarity = (typeof NEUTRAL_RARITIES)[number];

/** How far from Edaria an item comes from, the bestiary's rings: a further ring rolls higher. */
export const TIERS = [1, 2, 3, 4, 5] as const;
export type Tier = (typeof TIERS)[number];

export function isTier(value: number): value is Tier {
  return (TIERS as readonly number[]).includes(value);
}

/** The tiers a role's set pieces are made at. */
export const SET_TIERS = [3] as const satisfies readonly Tier[];
export type SetTier = (typeof SET_TIERS)[number];

export function isSetTier(tier: Tier): tier is SetTier {
  return (SET_TIERS as readonly Tier[]).includes(tier);
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

/** The two slots a bracelet is worn in. */
export const BRACELET_SLOTS = ['bracelet1', 'bracelet2'] as const satisfies readonly EquipSlot[];
export type BraceletSlot = (typeof BRACELET_SLOTS)[number];

export function isBraceletSlot(slot: EquipSlot): slot is BraceletSlot {
  return (BRACELET_SLOTS as readonly EquipSlot[]).includes(slot);
}

/** The kind of slot a base fits: a slot of its own, or `bracelet`, which fits either bracelet slot. */
export type SlotKind = Exclude<EquipSlot, BraceletSlot> | 'bracelet';

/**
 * Where the base is worn and how the catalog names it: a held item by one name whatever its tier, and
 * armour and jewellery, worn anywhere but in a hand, after their design at each tier, a role's set
 * piece after its line's design at each tier the line has one.
 */
type BaseItemName =
  | { slot: Hand; labelKey: string; tierLabelKeys?: never; lineLabelKeys?: never }
  | {
      slot: Exclude<SlotKind, Hand>;
      tierLabelKeys: Readonly<Record<Tier, string>>;
      lineLabelKeys: Readonly<Record<Role, Readonly<Record<SetTier, string>>>>;
      labelKey?: never;
    };

type BaseItem = BaseItemName & {
  tier: Tier;
  /** The coins an item of the base is worth before its rolls. The Moonstone, never sold, is worth nothing. */
  value: number;
  /** What a weapon in the main hand swings as. */
  weapon?: Weapon;
  /** The stats every item of the base carries before its affixes. */
  implicit?: Partial<Stats>;
  /** A Mystic's focus, which their kit needs in the off hand. */
  focus?: true;
  /** It comes only from the Healer's trial: it is never rolled, dropped, bought, or sold. */
  trialOnly?: true;
};

/**
 * The kinds of item there are, by id, each with the catalog keys it is named by. An id is saved
 * with every item, so it is kebab-case like a teaching id.
 */
export const BASE_ITEMS = {
  dagger: { labelKey: 'Dagger', slot: 'mainHand', tier: 1, value: 60, weapon: { damage: 6, balanceCost: 10 } },
  cudgel: { labelKey: 'Cudgel', slot: 'mainHand', tier: 1, value: 30, weapon: { damage: 8, balanceCost: 18 } },
  sword: { labelKey: 'Short sword', slot: 'mainHand', tier: 1, value: 150, weapon: { damage: 11, balanceCost: 24 } },
  mace: { labelKey: 'Mace', slot: 'mainHand', tier: 1, value: 240, weapon: { damage: 14, balanceCost: 32 } },
  buckler: { labelKey: 'Buckler', slot: 'offHand', tier: 1, value: 40, implicit: { guard: 2 } },
  shield: { labelKey: 'Round shield', slot: 'offHand', tier: 1, value: 90, implicit: { guard: 4 } },
  /** The Healer's tool. In the off hand it lets Mend mend the target and the Healer use their abilities. */
  moonstone: { labelKey: 'Moonstone', slot: 'offHand', tier: 1, value: 0, trialOnly: true },
  wand: { labelKey: 'Wand', slot: 'offHand', tier: 1, value: 80, focus: true },
  'bone-dagger': { labelKey: 'Bone dagger', slot: 'mainHand', tier: 3, value: 150, weapon: { damage: 10, balanceCost: 12 } },
  sabre: { labelKey: 'Sabre', slot: 'mainHand', tier: 3, value: 360, weapon: { damage: 18, balanceCost: 26 } },
  'war-axe': { labelKey: 'War axe', slot: 'mainHand', tier: 3, value: 600, weapon: { damage: 24, balanceCost: 36 } },
  'iron-buckler': { labelKey: 'Iron buckler', slot: 'offHand', tier: 3, value: 100, implicit: { guard: 5 } },
  'skull-shield': { labelKey: 'Skull shield', slot: 'offHand', tier: 3, value: 225, implicit: { guard: 9 } },
  'skull-staff': { labelKey: 'Skull staff', slot: 'offHand', tier: 3, value: 200, focus: true, implicit: { spiritMax: 10 } },
  cap: {
    tierLabelKeys: { 1: 'Courier straw hat', 2: "Forester's feather band", 3: 'Tarred reed brim', 4: "Trapper's hide band", 5: 'Oiled storm brim' },
    lineLabelKeys: { fighter: { 3: 'Grave iron kettle helm' }, healer: { 3: 'Linen wimple' }, mystic: { 3: 'Marsh witch hat' } },
    slot: 'head',
    tier: 1,
    value: 25,
    implicit: { spiritRecovery: 5 },
  },
  shoulders: {
    tierLabelKeys: { 1: 'Courier shoulders', 2: 'Leaf shoulder', 3: 'Ferry guards', 4: 'Pelt guards', 5: "Navigator's epaulettes" },
    lineLabelKeys: { fighter: { 3: 'Crypt pauldrons' }, healer: { 3: 'Vigil shoulders' }, mystic: { 3: 'Marsh shoulders' } },
    slot: 'shoulders',
    tier: 1,
    value: 40,
    implicit: { balanceRecovery: 10 },
  },
  tunic: {
    tierLabelKeys: { 1: 'Courier tunic', 2: 'Trail cape', 3: "Ferryman's raincoat", 4: "Trapper's baldric", 5: 'Shore coat' },
    lineLabelKeys: { fighter: { 3: 'Burial hauberk' }, healer: { 3: 'Vigil stole' }, mystic: { 3: 'Marsh veil' } },
    slot: 'chest',
    tier: 1,
    value: 50,
    implicit: { guard: 3 },
  },
  gloves: {
    tierLabelKeys: { 1: 'Dispatch gloves', 2: 'Bark-grip gloves', 3: 'Reedwork gloves', 4: 'Hide mitts', 5: "Sailmaker's gloves" },
    lineLabelKeys: { fighter: { 3: 'Crypt gauntlets' }, healer: { 3: 'Votive gloves' }, mystic: { 3: 'Candle gloves' } },
    slot: 'hands',
    tier: 1,
    value: 25,
    implicit: { swingSpeed: 4 },
  },
  trousers: {
    tierLabelKeys: { 1: 'Field trousers', 2: 'Brush trousers', 3: 'Wader trousers', 4: 'Trail leathers', 5: 'Storm trousers' },
    lineLabelKeys: { fighter: { 3: 'Crypt chausses' }, healer: { 3: 'Vigil trousers' }, mystic: { 3: 'Marsh trousers' } },
    slot: 'legs',
    tier: 1,
    value: 40,
    implicit: { healthMax: 6 },
  },
  boots: {
    tierLabelKeys: { 1: 'Trail boots', 2: 'Leaf gaiters', 3: 'Fen boots', 4: 'Climbing boots', 5: 'Deck boots' },
    lineLabelKeys: { fighter: { 3: 'Crypt sabatons' }, healer: { 3: 'Chapel boots' }, mystic: { 3: 'Marsh boots' } },
    slot: 'feet',
    tier: 1,
    value: 25,
    implicit: { balanceMax: 5 },
  },
  amulet: {
    tierLabelKeys: { 1: 'Wheat-ear pendant', 2: 'Beech leaf', 3: 'Lantern cage', 4: 'Bear claw', 5: 'Compass rose' },
    lineLabelKeys: { fighter: { 3: 'Portcullis' }, healer: { 3: 'Votive candle' }, mystic: { 3: 'Marsh eye' } },
    slot: 'neck',
    tier: 1,
    value: 70,
    implicit: { spiritMax: 5 },
  },
  bracelet: {
    tierLabelKeys: { 1: 'Dispatch wristband', 2: 'Maple twig', 3: 'Reed knot', 4: 'Antler tine', 5: 'Sounding weight' },
    lineLabelKeys: { fighter: { 3: 'Crypt grille' }, healer: { 3: 'Wax taper' }, mystic: { 3: 'Reed eye' } },
    slot: 'bracelet',
    tier: 1,
    value: 50,
    implicit: { damage: 1 },
  },
} as const satisfies Record<string, BaseItem>;
export type BaseItemId = keyof typeof BASE_ITEMS;

export function isBaseItemId(value: string): value is BaseItemId {
  return Object.hasOwn(BASE_ITEMS, value);
}

export function baseItem(baseId: BaseItemId): BaseItem {
  return BASE_ITEMS[baseId];
}

/** Armour and jewellery: the bases worn anywhere but in a hand, each named after its design at each tier. */
export type WardrobeBaseId = { [Id in BaseItemId]: (typeof BASE_ITEMS)[Id] extends { tierLabelKeys: object } ? Id : never }[BaseItemId];

export function isWardrobeBase(baseId: BaseItemId): baseId is WardrobeBaseId {
  return baseItem(baseId).tierLabelKeys !== undefined;
}

/** The slots an item of the base is worn in, in the order one is taken: a bracelet's two, any other base's one. */
export function slotsFor(baseId: BaseItemId): readonly EquipSlot[] {
  const kind = baseItem(baseId).slot;
  return kind === 'bracelet' ? BRACELET_SLOTS : [kind];
}

/** One stat line an item rolled, and how much it adds. */
export interface RolledAffix {
  affixId: AffixId;
  value: number;
}

/** An item of no role's set: its base, the tier it rolled at, and the stat lines its rarity gave it. */
export interface NeutralItem {
  baseId: BaseItemId;
  tier: Tier;
  rarity: NeutralRarity;
  affixes: readonly RolledAffix[];
  line?: undefined;
}

/** A piece of a role's set: epic, of armour or jewellery, at a tier its line has a design at. */
export interface SetPiece {
  baseId: WardrobeBaseId;
  tier: SetTier;
  rarity: 'epic';
  affixes: readonly RolledAffix[];
  /** The role whose set the item is a piece of. */
  line: Role;
}

/** An item: neutral, or a piece of a role's set. */
export type Item = NeutralItem | SetPiece;

/** An item a dreamer has, named by an id of its own while they keep it. */
export type ItemInstance = Item & { id: string };

/** A neutral item a dreamer has, under its own id. */
export type NeutralInstance = NeutralItem & { id: string };

/**
 * What an item's design goes by, for its name and its icon: its base, its tier, and a set piece's
 * line. It is one `Pick` of each kind of item, so a line stays tied to a set piece's base and tier.
 */
export type ItemDesign = Pick<NeutralItem, 'baseId' | 'tier' | 'line'> | Pick<SetPiece, 'baseId' | 'tier' | 'line'>;

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

/** A common item of the base, at the base's tier: what Mercus sells and a trial gives. */
export function commonItem(baseId: BaseItemId): NeutralItem {
  return { baseId, tier: baseItem(baseId).tier, rarity: 'common', affixes: [] };
}

/** A common item of the base, at the base's tier, under a new id. */
export function commonInstance(baseId: BaseItemId): NeutralInstance {
  return { id: newItemId(), ...commonItem(baseId) };
}

/**
 * The item of the fields, read from outside: with a line exactly when it is epic, and then only of
 * armour or jewellery at a tier set pieces are made at, so every item it gives has a design. Any
 * other fields make no item.
 */
export function itemOf({ baseId, tier, rarity, affixes, line }: Omit<Item, 'rarity' | 'line'> & { rarity: Rarity; line: Role | undefined }): Item | undefined {
  if (line === undefined) return rarity === 'epic' ? undefined : { baseId, tier, rarity, affixes };
  return rarity === 'epic' && isWardrobeBase(baseId) && isSetTier(tier) ? { baseId, tier, rarity, affixes, line } : undefined;
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
 * The catalog key of the display name of an item of the design, which the consumer resolves in its
 * locale: the base's own name, or the design armour and jewellery are made in at the tier, a set
 * piece's in its line's.
 */
export function itemDesignLabelKey(design: ItemDesign): string {
  if (design.line !== undefined) return BASE_ITEMS[design.baseId].lineLabelKeys[design.line][design.tier];
  return isWardrobeBase(design.baseId) ? BASE_ITEMS[design.baseId].tierLabelKeys[design.tier] : BASE_ITEMS[design.baseId].labelKey;
}

/**
 * The catalog key of the display name of an item a frame names by its base, tier, and line, as
 * `itemDesignLabelKey` gives it. An unknown id, a tier outside 1 to 5 for armour and jewellery, or a
 * line on a base or at a tier with no design of it resolves to `undefined` so a missing entry
 * surfaces rather than rendering a wrong label.
 */
export function itemLabelKey(baseId: string, tier: number, line?: Role): string | undefined {
  if (!isBaseItemId(baseId)) return undefined;
  if (!isWardrobeBase(baseId)) return line === undefined ? BASE_ITEMS[baseId].labelKey : undefined;
  if (!isTier(tier)) return undefined;
  if (line === undefined) return itemDesignLabelKey({ baseId, tier });
  return isSetTier(tier) ? itemDesignLabelKey({ baseId, tier, line }) : undefined;
}
