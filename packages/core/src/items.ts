import type { Hand } from '@somnio/protocol';

/** The items a character can carry, by id, each with the catalog key of its display name. */
export const ITEMS = {
  /** Its row's `quantity` is the coin count. */
  purse: { labelKey: 'Purse' },
  dagger: { labelKey: 'Dagger', weapon: { damage: 6, balanceCost: 10 } },
  cudgel: { labelKey: 'Cudgel', weapon: { damage: 8, balanceCost: 18 } },
  sword: { labelKey: 'Short sword', weapon: { damage: 11, balanceCost: 24 } },
  mace: { labelKey: 'Mace', weapon: { damage: 14, balanceCost: 32 } },
  /** The Healer's tool. In hand it mends the dreamer its holder tends, or its holder when used, and does not swing. */
  moonstone: { labelKey: 'Moonstone' },
} as const;
export type ItemId = keyof typeof ITEMS;

export interface Weapon {
  damage: number;
  /** The balance one swing costs. */
  balanceCost: number;
}

/**
 * The catalog key of an item's display name, which the consumer resolves in its locale. An unknown
 * id resolves to `undefined` so a missing entry surfaces rather than rendering a wrong label.
 */
export function itemLabelKey(itemId: string): string | undefined {
  return Object.hasOwn(ITEMS, itemId) ? ITEMS[itemId as ItemId].labelKey : undefined;
}

/** What an item swings as; `undefined` for an item that is no weapon and for an unknown id. */
export function itemWeapon(itemId: string): Weapon | undefined {
  const items: Record<string, { labelKey: string; weapon?: Weapon }> = ITEMS;
  return Object.hasOwn(items, itemId) ? items[itemId]?.weapon : undefined;
}

/** The item a dreamer holds: the row in the right hand, the one hand a client ever uses. */
export function itemInHand(rows: readonly { itemId: string; equippedHand?: Hand | undefined }[]): string | undefined {
  return rows.find((row) => row.equippedHand === 'right')?.itemId;
}

/** The coins a dreamer carries: their purse's quantity, and none without a purse. */
export function purseCoins(rows: readonly { itemId: string; quantity: number }[]): number {
  return rows.find((row) => row.itemId === ('purse' satisfies ItemId))?.quantity ?? 0;
}
