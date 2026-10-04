import type { InventoryRow } from '@somnio/core';

/** A purse holding 100 coins and a cudgel in the secondary slot. */
export const STARTER_INVENTORY: readonly InventoryRow[] = [
  { slot: 0, itemId: 'purse', quantity: 100, equippedHand: undefined },
  { slot: 1, itemId: 'cudgel', quantity: 1, equippedHand: undefined },
];
