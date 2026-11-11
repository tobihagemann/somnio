import { bagHasRoom } from './domain/inventory.ts';
import type { Inventory } from './domain/inventory.ts';
import { baseItem } from './items.ts';
import type { BaseItemId, Item, ItemInstance, Rarity } from './items.ts';

/**
 * What the shopkeeper sells, plain and at tier 1, in shelf order, and what he pays for an item of
 * each rarity for each tier it rolled at. The numbers are tuned in play, as `COMBAT`'s are.
 */
export const SHOP = {
  prices: {
    dagger: 60,
    cudgel: 30,
    sword: 150,
    mace: 240,
    buckler: 40,
    shield: 90,
    wand: 80,
    cap: 25,
    tunic: 50,
    gloves: 25,
    trousers: 40,
    boots: 25,
    amulet: 70,
    ring: 50,
  },
  salePerTier: { plain: 10, magic: 30, rare: 75 },
} as const satisfies { prices: Partial<Record<BaseItemId, number>>; salePerTier: Record<Rarity, number> };
export type Ware = keyof typeof SHOP.prices;

export const WARES = Object.keys(SHOP.prices) as Ware[];

export function isWare(baseId: string): baseId is Ware {
  return Object.hasOwn(SHOP.prices, baseId);
}

/** What the shopkeeper pays for the item: by its rarity, for each tier it rolled at. */
export function salePrice(item: Item): number {
  return SHOP.salePerTier[item.rarity] * item.tier;
}

/** Whether a dreamer can buy a plain one of the base: a ware their purse covers, into a bag with room. */
export function canBuy(inventory: Inventory, baseId: string): baseId is Ware {
  return isWare(baseId) && inventory.coins >= SHOP.prices[baseId] && bagHasRoom(inventory);
}

/** The item in a dreamer's bag the shopkeeper buys, by its id: anything there but the Moonstone. What they wear is not for sale. */
export function sellableItem(inventory: Inventory, itemId: string): ItemInstance | undefined {
  return inventory.bag.find(({ item }) => item.id === itemId && baseItem(item.baseId).trialOnly !== true)?.item;
}
