import { purseCoins } from './items.ts';
import type { ItemId } from './items.ts';

/** What the shopkeeper sells, in shelf order, and the share of a price paid to buy one back. The prices are tuned in play, as `COMBAT`'s numbers are. */
export const SHOP = {
  prices: { dagger: 60, cudgel: 30, sword: 150, mace: 240 },
  buyBackShare: 0.5,
} as const satisfies { prices: Partial<Record<ItemId, number>>; buyBackShare: number };
export type Ware = keyof typeof SHOP.prices;

export const WARES = Object.keys(SHOP.prices) as Ware[];

/** The rows a rule reads, which a row off the wire satisfies too. */
type Rows = readonly { itemId: string; quantity: number }[];

export function isWare(itemId: string): itemId is Ware {
  return Object.hasOwn(SHOP.prices, itemId);
}

export function buyBackPrice(ware: Ware): number {
  return Math.floor(SHOP.prices[ware] * SHOP.buyBackShare);
}

function carries(rows: Rows, itemId: string): boolean {
  return rows.some((row) => row.itemId === itemId);
}

/** Whether a dreamer can buy the item: a ware they do not carry, one of each, which their purse covers. */
export function canBuy(rows: Rows, itemId: string): itemId is Ware {
  return isWare(itemId) && !carries(rows, itemId) && purseCoins(rows) >= SHOP.prices[itemId];
}

/** Whether a dreamer can sell the item: a ware they carry. The purse and the Mondstein are no wares. */
export function canSell(rows: Rows, itemId: string): itemId is Ware {
  return isWare(itemId) && carries(rows, itemId);
}
