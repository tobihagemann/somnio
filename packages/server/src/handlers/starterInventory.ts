import { GOLD_KEY } from '@somnio/core'
import type { InventoryRow } from '@somnio/core'

/** A purse holding 100 coins and a cudgel in the secondary slot. */
export const STARTER_INVENTORY: readonly InventoryRow[] = [
  { slot: 0, category: 0, itemId: 0, extras: [{ key: GOLD_KEY, value: 100 }], equippedHand: undefined },
  { slot: 1, category: 1, itemId: 0, extras: [], equippedHand: undefined },
]
