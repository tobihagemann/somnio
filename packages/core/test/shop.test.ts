import { describe, expect, it } from 'vitest';
import { WARES, buyBackPrice, canBuy, canSell, isWare } from '../src/shop.ts';

const purse = (quantity: number) => ({ itemId: 'purse', quantity });
const carried = (itemId: string) => ({ itemId, quantity: 1 });

describe('the shop', () => {
  it('shelves its wares in order', () => {
    expect(WARES).toEqual(['dagger', 'cudgel', 'sword', 'mace']);
  });

  it('buys each ware back for half its price, rounded down', () => {
    expect(WARES.map(buyBackPrice)).toEqual([30, 15, 75, 120]);
  });

  it('deals in weapons alone, and in nothing inherited from an object', () => {
    expect(isWare('dagger')).toBe(true);
    expect(['purse', 'moonstone', 'toString'].map(isWare)).toEqual([false, false, false]);
  });

  it('sells a ware the purse covers and the dreamer does not carry', () => {
    expect(canBuy([purse(60)], 'dagger')).toBe(true);
    expect(canBuy([purse(59)], 'dagger')).toBe(false);
    expect(canBuy([purse(100), carried('dagger')], 'dagger')).toBe(false);
    expect(canBuy([purse(100)], 'moonstone')).toBe(false);
  });

  it('buys back only a ware the dreamer carries', () => {
    expect(canSell([carried('cudgel')], 'cudgel')).toBe(true);
    expect(canSell([carried('cudgel')], 'mace')).toBe(false);
    expect(canSell([purse(100), carried('moonstone')], 'moonstone')).toBe(false);
    expect(canSell([purse(100)], 'purse')).toBe(false);
  });
});
