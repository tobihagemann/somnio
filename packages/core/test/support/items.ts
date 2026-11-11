import type { BaggedItem, Inventory } from '../../src/domain/inventory.ts';
import { equipSlot } from '../../src/items.ts';
import type { BaseItemId, Hands, Item, ItemInstance } from '../../src/items.ts';

/** A plain tier-1 item of the base. */
export function plain(baseId: BaseItemId): Item {
  return { baseId, tier: 1, rarity: 'plain', affixes: [] };
}

/** The hands holding what is given, each left empty for `undefined`. */
export function holding(mainHand: Item | undefined, offHand: Item | undefined): Hands {
  return { ...(mainHand === undefined ? {} : { mainHand }), ...(offHand === undefined ? {} : { offHand }) };
}

/** A bag of the items, at the places from 0 in the order given. */
export function bagOf(items: readonly ItemInstance[]): BaggedItem[] {
  return items.map((item, place) => ({ place, item }));
}

/** An inventory of the coins, each item of `worn` in the slot equipping it takes, and `bag` at the places from 0 in the order given. */
export function carrying({
  coins = 0,
  worn = [],
  bag = [],
}: { coins?: number; worn?: readonly ItemInstance[]; bag?: readonly ItemInstance[] } = {}): Inventory {
  const equipped = worn.reduce<Inventory['equipped']>((sofar, item) => ({ ...sofar, [equipSlot(sofar, item.baseId)]: item }), {});
  return { coins, equipped, bag: bagOf(bag) };
}
