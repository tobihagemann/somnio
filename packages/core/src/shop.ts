import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import { affix } from './affixes.ts';
import { bagHasRoom } from './domain/inventory.ts';
import type { Inventory } from './domain/inventory.ts';
import { baseItem } from './items.ts';
import type { BaseItemId, Item, ItemInstance } from './items.ts';

/**
 * What the shopkeeper sells, plain and at tier 1, in shelf order, and the share of an item's value
 * he pays for it. The share is tuned in play, as `COMBAT`'s numbers are.
 */
export const SHOP = {
  wares: ['dagger', 'cudgel', 'sword', 'mace', 'buckler', 'shield', 'wand', 'cap', 'shoulders', 'tunic', 'gloves', 'trousers', 'boots', 'amulet', 'bracelet'],
  saleShare: 0.5,
} as const satisfies { wares: readonly BaseItemId[]; saleShare: number };
export type Ware = (typeof SHOP.wares)[number];

export const WARES: readonly Ware[] = SHOP.wares;

export function isWare(baseId: string): baseId is Ware {
  return (WARES as readonly string[]).includes(baseId);
}

/** What the shopkeeper sells a plain one of the ware for: its base's value. */
export function price(ware: Ware): number {
  return baseItem(ware).value;
}

/** What an item is worth: its base's value, and each line it rolled by how high it rolled. */
export function itemValue(item: Item): number {
  return item.affixes.reduce((value, line) => value + line.value * affix(line.affixId).worth, baseItem(item.baseId).value);
}

/** What the shopkeeper pays for the item: his share of its value, rounded down. */
export function salePrice(item: Item): number {
  return Math.floor(itemValue(item) * SHOP.saleShare);
}

/** Whether a dreamer can buy a plain one of the base: a ware their purse covers, into a bag with room. */
export function canBuy(inventory: Inventory, baseId: string): baseId is Ware {
  return isWare(baseId) && inventory.coins >= price(baseId) && bagHasRoom(inventory);
}

/** Whether the shopkeeper buys an item of its kind: any but the Moonstone. */
export function sellable(item: Item): boolean {
  return baseItem(item.baseId).trialOnly !== true;
}

/** The item in a dreamer's bag the shopkeeper buys, by its id: anything there he buys. What they wear is not for sale. */
export function sellableItem(inventory: Inventory, itemId: string): ItemInstance | undefined {
  const item = inventory.bag.find((bagged) => bagged.item.id === itemId)?.item;
  return item !== undefined && sellable(item) ? item : undefined;
}

/** The item a dreamer sold the shopkeeper that they can buy back, by its id: one he still holds for them, for what he paid, into a bag with room. */
export function buyBackable(inventory: Inventory, soldToShop: readonly ItemInstance[], itemId: string): ItemInstance | undefined {
  const item = soldToShop.find((sold) => sold.id === itemId);
  return item !== undefined && inventory.coins >= salePrice(item) && bagHasRoom(inventory) ? item : undefined;
}

/** What the shopkeeper holds for a dreamer to buy back after a sale: the item just sold at the front, keeping the newest `maxBuyBackItems`. */
export function soldToShopAfterSale(soldToShop: readonly ItemInstance[], sold: ItemInstance): ItemInstance[] {
  return [sold, ...soldToShop].slice(0, SOMNIO_PROTOCOL_CONSTANTS.maxBuyBackItems);
}
