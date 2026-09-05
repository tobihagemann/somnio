/**
 * The hand an item is equipped in. Distinct from the wire's `WIRE_HAND` by one: the wire reserves
 * 0 for "no hand" while unequipped is `undefined` here, so the two must never be compared
 * directly — `handFromWire`/`handToWire` are the conversions.
 */
export const HAND = { left: 0, right: 1 } as const;
export type Hand = (typeof HAND)[keyof typeof HAND];

/** Extra key carrying the purse's coin balance. A typo here would silently read 0. */
export const GOLD_KEY = 'gold';

/**
 * Ordered category-specific extras (`{"gold": N}` for the purse). The ordered-array form keeps
 * serialization deterministic; map-style lookup builds a transient index.
 */
export interface InventoryExtra {
  key: string;
  value: number;
}

export interface InventoryRow {
  slot: number;
  category: number;
  itemId: number;
  extras: InventoryExtra[];
  /** `undefined` when unequipped; see `HAND` for the two equipped values. */
  equippedHand: Hand | undefined;
}

/** Coin balance carried by the `gold` extra (the purse), or 0 when absent. */
export function goldBalance(row: InventoryRow): number {
  return row.extras.find((extra) => extra.key === GOLD_KEY)?.value ?? 0;
}
