import { inventoryMessage } from '@somnio/core';
import type { BaseItemId, Inventory, InventoryChange, ItemInstance } from '@somnio/core';
import type { SomnioMessage } from '@somnio/protocol';

export { carrying } from '../../../core/test/support/items.ts';

/** A plain tier-1 item of the base, under an id named for it. */
export function item(baseId: BaseItemId, id = `${baseId}-1`): ItemInstance {
  return { id, baseId, tier: 1, rarity: 'plain', affixes: [] };
}

/** The `inventory` frame the server sends for the inventory, with what changed hands to produce it. */
export function inventoryFrame(inventory: Inventory, change?: InventoryChange): SomnioMessage {
  return { tag: 'inventory', payload: inventoryMessage(inventory, change) };
}
