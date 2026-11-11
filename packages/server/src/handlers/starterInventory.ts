import { plainInstance } from '@somnio/core';
import type { BaseItemId, Inventory } from '@somnio/core';

/** What a new character starts with: 100 coins and a cudgel in the bag. */
const STARTER_KIT = { coins: 100, bag: ['cudgel'] } as const satisfies { coins: number; bag: readonly BaseItemId[] };

/** The starter kit as a new character's inventory, each item plain under an id of its own. */
export function starterInventory(): Inventory {
  return { coins: STARTER_KIT.coins, equipped: {}, bag: STARTER_KIT.bag.map((baseId, place) => ({ place, item: plainInstance(baseId) })) };
}
