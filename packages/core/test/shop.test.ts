import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import { describe, expect, it } from 'vitest';
import type { Inventory } from '../src/domain/inventory.ts';
import { BASE_ITEMS, baseItem, plainInstance } from '../src/items.ts';
import type { BaseItemId, ItemInstance } from '../src/items.ts';
import { WARES, canBuy, isWare, salePrice, sellableItem } from '../src/shop.ts';
import { bagOf } from './support/items.ts';

const purse = (coins: number): Inventory => ({ coins, equipped: {}, bag: [] });

describe('the shop', () => {
  it('shelves every base of tier 1 but the Moonstone, in order', () => {
    expect(WARES).toEqual(['dagger', 'cudgel', 'sword', 'mace', 'buckler', 'shield', 'wand', 'cap', 'tunic', 'gloves', 'trousers', 'boots', 'amulet', 'ring']);
    expect((Object.keys(BASE_ITEMS) as BaseItemId[]).filter((baseId) => baseItem(baseId).tier === 1 && !isWare(baseId))).toEqual(['moonstone']);
    expect(WARES.every((ware) => baseItem(ware).tier === 1)).toBe(true);
  });

  it('pays for an item by its rarity, for each tier it rolled at', () => {
    const piece = (rarity: ItemInstance['rarity'], tier: ItemInstance['tier']) => ({ ...plainInstance('cap'), rarity, tier });
    expect([piece('plain', 1), piece('magic', 1), piece('rare', 1), piece('rare', 3)].map(salePrice)).toEqual([10, 30, 75, 225]);
  });

  it('deals in nothing inherited from an object', () => {
    expect(['purse', 'moonstone', 'toString'].map(isWare)).toEqual([false, false, false]);
  });

  it('sells a ware the purse covers, however many of it the dreamer carries, into a bag with room', () => {
    expect(canBuy(purse(60), 'dagger')).toBe(true);
    expect(canBuy(purse(59), 'dagger')).toBe(false);
    expect(canBuy({ ...purse(100), equipped: { mainHand: plainInstance('dagger') }, bag: bagOf([plainInstance('dagger')]) }, 'dagger')).toBe(true);
    expect(canBuy(purse(1000), 'moonstone')).toBe(false);
    const full = bagOf(Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxBagItems }, () => plainInstance('cap')));
    expect(canBuy({ ...purse(100), bag: full }, 'dagger')).toBe(false);
    expect(canBuy({ ...purse(100), bag: full.slice(1) }, 'dagger')).toBe(true);
  });

  it('buys anything from the bag by its id but the Moonstone, and nothing worn', () => {
    const cudgel = plainInstance('cudgel');
    const amulet: ItemInstance = { ...plainInstance('amulet'), rarity: 'rare', affixes: [{ affixId: 'health', value: 5 }] };
    const moonstone = plainInstance('moonstone');
    const sword = plainInstance('sword');
    const inventory: Inventory = { coins: 100, equipped: { mainHand: sword }, bag: bagOf([cudgel, amulet, moonstone]) };
    expect([cudgel.id, amulet.id].map((itemId) => sellableItem(inventory, itemId))).toEqual([cudgel, amulet]);
    expect([moonstone.id, sword.id, 'purse'].map((itemId) => sellableItem(inventory, itemId))).toEqual([undefined, undefined, undefined]);
  });
});
