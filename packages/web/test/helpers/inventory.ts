import { inventoryMessage, rollSetPiece } from '@somnio/core';
import type { BaseItemId, Inventory, InventoryChange, ItemInstance, WardrobeBaseId } from '@somnio/core';
import type { Role, SomnioMessage } from '@somnio/protocol';

export { carrying } from '../../../core/test/support/items.ts';

/** A common tier-1 item of the base, under an id named for it. */
export function item(baseId: BaseItemId, id = `${baseId}-1`): ItemInstance {
  return { id, baseId, tier: 1, rarity: 'common', affixes: [] };
}

/** A base for each armour and jewellery slot, in the order `carrying` wears them into those slots. */
const SET_BASES: readonly WardrobeBaseId[] = ['cap', 'shoulders', 'tunic', 'gloves', 'trousers', 'boots', 'amulet', 'bracelet', 'bracelet'];

/** The first `count` pieces of the line's set, one for each armour and jewellery slot in turn, under ids named for them. */
export function setOf(count: number, line: Role): ItemInstance[] {
  return SET_BASES.slice(0, count).map((baseId, index) => ({ id: `${baseId}-${line}-${index}`, ...rollSetPiece(baseId, 3, line, () => 0.5) }));
}

/** The `inventory` frame the server sends for the inventory, with what changed hands to produce it and what the shopkeeper holds to buy back. */
export function inventoryFrame(inventory: Inventory, change?: InventoryChange, buyBack?: readonly ItemInstance[]): SomnioMessage {
  return { tag: 'inventory', payload: inventoryMessage(inventory, change, buyBack) };
}
