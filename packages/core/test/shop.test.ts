import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import { describe, expect, it } from 'vitest';
import { AFFIXES } from '../src/affixes.ts';
import type { AffixId } from '../src/affixes.ts';
import type { Inventory } from '../src/domain/inventory.ts';
import { BASE_ITEMS, baseItem, plainInstance, plainItem } from '../src/items.ts';
import type { BaseItemId, ItemInstance } from '../src/items.ts';
import { WARES, buyBackable, canBuy, isWare, itemValue, price, salePrice, sellable, sellableItem, soldToShopAfterSale } from '../src/shop.ts';
import { bagOf } from './support/items.ts';

const purse = (coins: number): Inventory => ({ coins, equipped: {}, bag: [] });

describe('the shop', () => {
  it('shelves every base of tier 1 but the Moonstone, in order', () => {
    expect(WARES).toEqual([
      'dagger',
      'cudgel',
      'sword',
      'mace',
      'buckler',
      'shield',
      'wand',
      'cap',
      'shoulders',
      'tunic',
      'gloves',
      'trousers',
      'boots',
      'amulet',
      'bracelet',
    ]);
    expect((Object.keys(BASE_ITEMS) as BaseItemId[]).filter((baseId) => baseItem(baseId).tier === 1 && !isWare(baseId))).toEqual(['moonstone']);
    expect(WARES.every((ware) => baseItem(ware).tier === 1)).toBe(true);
  });

  it('sells each ware at its base value', () => {
    expect(WARES.map(price)).toEqual([60, 30, 150, 240, 40, 90, 80, 25, 40, 50, 25, 40, 25, 70, 50]);
  });

  it('pays half an item value, rounded down', () => {
    expect(salePrice(plainItem('sword'))).toBe(75);
    expect(salePrice(plainItem('cap'))).toBe(12);
  });

  it('adds each rolled line to the value at its worth for each point', () => {
    const trousers = {
      ...plainItem('trousers'),
      rarity: 'magic' as const,
      affixes: [
        { affixId: 'health' as const, value: 3 },
        { affixId: 'guard' as const, value: 2 },
      ],
    };
    expect(itemValue(trousers)).toBe(40 + 3 * AFFIXES.health.worth + 2 * AFFIXES.guard.worth);
    expect(salePrice(trousers)).toBe(Math.floor((40 + 15 + 26) / 2));
  });

  it('never pays less for a line that rolled higher', () => {
    for (const affixId of Object.keys(AFFIXES) as AffixId[]) {
      const [least, most] = AFFIXES[affixId].tiers[3];
      const sales = Array.from({ length: most - least + 1 }, (_, step) =>
        salePrice({ ...plainItem('amulet'), tier: 3, rarity: 'magic', affixes: [{ affixId, value: least + step }] }),
      );
      expect(sales).toEqual([...sales].sort((a, b) => a - b));
    }
  });

  it('buys back no ware at its shelf price or more', () => {
    expect(WARES.filter((ware) => salePrice(plainItem(ware)) >= price(ware))).toEqual([]);
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

  it('buys an item of every kind but the Moonstone', () => {
    expect((Object.keys(BASE_ITEMS) as BaseItemId[]).filter((baseId) => !sellable(plainItem(baseId)))).toEqual(['moonstone']);
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

  it('sells back an item he holds for what he paid, into a bag with room', () => {
    const cap = plainInstance('cap');
    const sold = [plainInstance('sword'), cap];
    expect(buyBackable(purse(12), sold, cap.id)).toBe(cap);
    expect(buyBackable(purse(11), sold, cap.id)).toBeUndefined();
    expect(buyBackable(purse(100), sold, plainInstance('cap').id)).toBeUndefined();
    const full = bagOf(Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxBagItems }, () => plainInstance('cap')));
    expect(buyBackable({ ...purse(100), bag: full }, sold, cap.id)).toBeUndefined();
  });

  it('holds the newest sale first, and no more than the cap', () => {
    const sales = Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxBuyBackItems + 1 }, () => plainInstance('cap'));
    const held = sales.reduce<ItemInstance[]>(soldToShopAfterSale, []);
    expect(held).toEqual(sales.slice(1).reverse());
  });
});
