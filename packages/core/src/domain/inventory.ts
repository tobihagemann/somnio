import { EQUIP_SLOTS, SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import type { InventoryMessage, ItemMessage } from '@somnio/protocol';
import { isAffixId } from '../affixes.ts';
import { equipSlot, isBaseItemId, isTier, slotsFor } from '../items.ts';
import type { BaseItemId, EquipSlot, ItemInstance } from '../items.ts';

/** An item in the bag, at the place the dreamer keeps it, from 0 to one less than `maxBagItems`. */
export interface BaggedItem {
  place: number;
  item: ItemInstance;
}

/** Everything a dreamer carries: their coins, what they wear by slot, and their bag in place order, one item to a place. */
export interface Inventory {
  coins: number;
  equipped: Partial<Record<EquipSlot, ItemInstance>>;
  bag: readonly BaggedItem[];
}

export function isBagPlace(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < SOMNIO_PROTOCOL_CONSTANTS.maxBagItems;
}

/** Whether the dreamer's bag takes one more item: the one rule every way into the bag reads, so the bag never passes `maxBagItems`. */
export function bagHasRoom(inventory: Inventory): boolean {
  return inventory.bag.length < SOMNIO_PROTOCOL_CONSTANTS.maxBagItems;
}

/** The first place in the bag that holds nothing, where a new item goes; `undefined` in a full bag. */
export function firstFreePlace(inventory: Inventory): number | undefined {
  const taken = new Set(inventory.bag.map(({ place }) => place));
  for (let place = 0; place < SOMNIO_PROTOCOL_CONSTANTS.maxBagItems; place += 1) if (!taken.has(place)) return place;
  return undefined;
}

export function itemAtPlace(inventory: Inventory, place: number): ItemInstance | undefined {
  return inventory.bag.find((bagged) => bagged.place === place)?.item;
}

/** Everything a dreamer carries before the first `inventory` frame says otherwise: nothing. */
export const NO_INVENTORY: Inventory = { coins: 0, equipped: {}, bag: [] };

/** Where an item of the base given to the dreamer goes: the first slot it fits that is empty, else the bag while it has room, else nowhere. */
export function grantPlace(inventory: Inventory, baseId: BaseItemId): EquipSlot | 'bag' | undefined {
  const slot = slotsFor(baseId).find((fits) => inventory.equipped[fits] === undefined);
  if (slot !== undefined) return slot;
  return bagHasRoom(inventory) ? 'bag' : undefined;
}

/** The inventory with the item given to the dreamer where `grantPlace` puts it; `undefined` with room in neither a slot nor the bag. */
export function grantItem(inventory: Inventory, item: ItemInstance): Inventory | undefined {
  const place = grantPlace(inventory, item.baseId);
  if (place === undefined) return undefined;
  return place === 'bag' ? withItem(inventory, item) : { ...inventory, equipped: { ...inventory.equipped, [place]: item } };
}

/** The inventory with the item put in the bag, at `place` or else the first free place. The caller checks the bag has room. */
export function withItem(inventory: Inventory, item: ItemInstance, place = firstFreePlace(inventory)!): Inventory {
  return { ...inventory, bag: inBagOrder([...inventory.bag, { place, item }]) };
}

/** The inventory without the item, from the bag or from the slot that wears it. */
export function withoutItem(inventory: Inventory, itemId: string): Inventory {
  const equipped = Object.fromEntries(Object.entries(inventory.equipped).filter(([, worn]) => worn.id !== itemId));
  return { ...inventory, equipped, bag: inventory.bag.filter(({ item }) => item.id !== itemId) };
}

/**
 * Wears an item the dreamer has in `slot`, one its base fits, or else in the slot `equipSlot`
 * chooses. From the bag, whatever the slot wore takes the item's place there. Worn in the other
 * ring slot, the two rings change slots. `undefined` when the dreamer has no such item or the base
 * does not fit the slot.
 */
export function equipItem(inventory: Inventory, itemId: string, slot?: EquipSlot): Inventory | undefined {
  const bagged = inventory.bag.find(({ item }) => item.id === itemId);
  const wornIn = (Object.keys(inventory.equipped) as EquipSlot[]).find((worn) => inventory.equipped[worn]!.id === itemId);
  const item = bagged?.item ?? (wornIn === undefined ? undefined : inventory.equipped[wornIn]);
  if (item === undefined) return undefined;
  const into = slot ?? equipSlot(inventory.equipped, item.baseId);
  if (!slotsFor(item.baseId).includes(into)) return undefined;
  if (into === wornIn) return inventory;
  const displaced = inventory.equipped[into];
  const equipped = { ...inventory.equipped, [into]: item };
  if (wornIn !== undefined) {
    if (displaced === undefined) delete equipped[wornIn];
    else equipped[wornIn] = displaced;
    return { ...inventory, equipped };
  }
  const bag = inventory.bag.filter((entry) => entry !== bagged);
  return { ...inventory, equipped, bag: displaced === undefined ? bag : inBagOrder([...bag, { place: bagged!.place, item: displaced }]) };
}

/**
 * Puts what the slot wears into the bag: at `place` when it is free, else at the first free place.
 * Onto a place holding an item that fits the slot, the two change places, the bag's item worn in
 * the slot. `undefined` when the slot is empty, or the bag is full and no item changes places.
 */
export function unequipItem(inventory: Inventory, slot: EquipSlot, place?: number): Inventory | undefined {
  const worn = inventory.equipped[slot];
  if (worn === undefined) return undefined;
  const there = place === undefined ? undefined : itemAtPlace(inventory, place);
  if (there !== undefined && slotsFor(there.baseId).includes(slot)) return equipItem(inventory, there.id, slot);
  if (!bagHasRoom(inventory)) return undefined;
  const equipped = { ...inventory.equipped };
  delete equipped[slot];
  return withItem({ ...inventory, equipped }, worn, there === undefined && place !== undefined ? place : firstFreePlace(inventory)!);
}

/**
 * Moves an item the dreamer has to a place in the bag. From another place, onto an occupied place
 * the two change places. A worn item is put away as `unequipItem` puts it at that place.
 */
export function moveItem(inventory: Inventory, itemId: string, place: number): Inventory | undefined {
  if (!isBagPlace(place)) return undefined;
  const wornIn = (Object.keys(inventory.equipped) as EquipSlot[]).find((slot) => inventory.equipped[slot]!.id === itemId);
  if (wornIn !== undefined) return unequipItem(inventory, wornIn, place);
  const moved = inventory.bag.find(({ item }) => item.id === itemId);
  if (moved === undefined) return undefined;
  if (moved.place === place) return inventory;
  const bag = inventory.bag.map((bagged) => {
    if (bagged === moved) return { place, item: bagged.item };
    return bagged.place === place ? { place: moved.place, item: bagged.item } : bagged;
  });
  return { ...inventory, bag: inBagOrder(bag) };
}

function inBagOrder(bag: BaggedItem[]): BaggedItem[] {
  return bag.sort((a, b) => a.place - b.place);
}

/** What changed hands to produce an `inventory` frame, which the frame carries beside what the dreamer now has. */
export type InventoryChange = Pick<InventoryMessage, 'trade' | 'dropped' | 'pickedUp'>;

/** The `inventory` frame of what the dreamer carries, worn items in slot order and the bag in place order. */
export function inventoryMessage(inventory: Inventory, change: InventoryChange = {}): InventoryMessage {
  return {
    coins: inventory.coins,
    equipped: EQUIP_SLOTS.flatMap((slot) => {
      const item = inventory.equipped[slot];
      return item === undefined ? [] : [{ slot, item: itemMessage(item) }];
    }),
    bag: inventory.bag.map(({ place, item }) => ({ place, item: itemMessage(item) })),
    ...change,
  };
}

/** What an `inventory` frame says the dreamer carries, without any item this build does not know or that is worn in a slot its base does not fit. */
export function inventoryOf(message: InventoryMessage): Inventory {
  const equipped: Inventory['equipped'] = {};
  for (const { slot, item } of message.equipped) {
    const known = knownItem(item);
    if (known !== undefined && slotsFor(known.baseId).includes(slot)) equipped[slot] = known;
  }
  const bag = message.bag.flatMap(({ place, item }) => {
    const known = knownItem(item);
    return known === undefined ? [] : [{ place, item: known }];
  });
  return { coins: message.coins, equipped, bag: inBagOrder(bag) };
}

function itemMessage({ id, baseId, tier, rarity, affixes }: ItemInstance): ItemMessage {
  return { id, baseId, tier, rarity, affixes: affixes.map(({ affixId, value }) => ({ affixId, value })) };
}

function knownItem({ id, baseId, tier, rarity, affixes }: ItemMessage): ItemInstance | undefined {
  const known = affixes.flatMap(({ affixId, value }) => (isAffixId(affixId) ? [{ affixId, value }] : []));
  if (!isBaseItemId(baseId) || !isTier(tier) || known.length < affixes.length) return undefined;
  return { id, baseId, tier, rarity, affixes: known };
}
