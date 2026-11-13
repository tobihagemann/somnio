import { plainInstance } from '@somnio/core';
import type { Inventory } from '@somnio/core';

/** A new character's purse and kit. The cudgel starts in the main hand, so they swing it from their first step. */
export function starterInventory(): Inventory {
  return { coins: 100, equipped: { mainHand: plainInstance('cudgel') }, bag: [] };
}
