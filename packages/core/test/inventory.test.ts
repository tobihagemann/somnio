import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import { describe, expect, it } from 'vitest';
import {
  bagHasRoom,
  buyBackOf,
  equipItem,
  firstFreePlace,
  grantItem,
  grantPlace,
  inventoryMessage,
  inventoryOf,
  moveItem,
  unequipItem,
  withItem,
} from '../src/domain/inventory.ts';
import type { Inventory } from '../src/domain/inventory.ts';
import { equipSlot, plainInstance, slotsFor } from '../src/items.ts';
import type { ItemInstance } from '../src/items.ts';
import { bagOf } from './support/items.ts';

const capsOf = (count: number) => bagOf(Array.from({ length: count }, (_, index) => ({ ...plainInstance('cap'), id: `cap-${index}` })));
const item = (baseId: Parameters<typeof plainInstance>[0], id: string): ItemInstance => ({ ...plainInstance(baseId), id });
const placesOf = (inventory: Inventory) => inventory.bag.map(({ place, item: { id } }) => [place, id]);

describe('the bag', () => {
  it('has room below its cap and none at it', () => {
    expect(bagHasRoom({ coins: 0, equipped: {}, bag: capsOf(SOMNIO_PROTOCOL_CONSTANTS.maxBagItems - 1) })).toBe(true);
    expect(bagHasRoom({ coins: 0, equipped: {}, bag: capsOf(SOMNIO_PROTOCOL_CONSTANTS.maxBagItems) })).toBe(false);
  });

  it('takes a granted item into its empty slot, else into the bag, else nowhere', () => {
    const wand: Inventory['equipped'] = { offHand: plainInstance('wand') };
    expect(grantPlace({ coins: 0, equipped: {}, bag: capsOf(SOMNIO_PROTOCOL_CONSTANTS.maxBagItems) }, 'moonstone')).toBe('offHand');
    expect(grantPlace({ coins: 0, equipped: wand, bag: capsOf(SOMNIO_PROTOCOL_CONSTANTS.maxBagItems - 1) }, 'moonstone')).toBe('bag');
    expect(grantPlace({ coins: 0, equipped: wand, bag: capsOf(SOMNIO_PROTOCOL_CONSTANTS.maxBagItems) }, 'moonstone')).toBeUndefined();
    expect(grantPlace({ coins: 0, equipped: { bracelet1: plainInstance('bracelet') }, bag: capsOf(SOMNIO_PROTOCOL_CONSTANTS.maxBagItems) }, 'bracelet')).toBe(
      'bracelet2',
    );
  });

  it('gives an item into its empty slot with the bag full and leaves the bag as it was, into the bag else, and nowhere with room in neither', () => {
    const full = capsOf(SOMNIO_PROTOCOL_CONSTANTS.maxBagItems);
    const moonstone = item('moonstone', 'moonstone');
    const intoHand = grantItem({ coins: 0, equipped: {}, bag: full }, moonstone)!;
    expect(intoHand.equipped).toEqual({ offHand: moonstone });
    expect(intoHand.bag).toBe(full);
    const wand: Inventory['equipped'] = { offHand: item('wand', 'wand') };
    expect(placesOf(grantItem({ coins: 0, equipped: wand, bag: [{ place: 1, item: item('cap', 'a') }] }, moonstone)!)).toEqual([
      [0, 'moonstone'],
      [1, 'a'],
    ]);
    expect(grantItem({ coins: 0, equipped: wand, bag: full }, moonstone)).toBeUndefined();
  });

  it('puts a new item at the first free place, past the places taken', () => {
    const bag = [
      { place: 0, item: item('cap', 'a') },
      { place: 2, item: item('cap', 'b') },
    ];
    const inventory: Inventory = { coins: 0, equipped: {}, bag };
    expect(firstFreePlace(inventory)).toBe(1);
    expect(placesOf(withItem(inventory, item('boots', 'c')))).toEqual([
      [0, 'a'],
      [1, 'c'],
      [2, 'b'],
    ]);
    expect(firstFreePlace({ coins: 0, equipped: {}, bag: capsOf(SOMNIO_PROTOCOL_CONSTANTS.maxBagItems) })).toBeUndefined();
  });
});

describe('arranging the bag', () => {
  const cap = item('cap', 'cap');
  const boots = item('boots', 'boots');
  const inventory: Inventory = {
    coins: 0,
    equipped: {},
    bag: [
      { place: 0, item: cap },
      { place: 5, item: boots },
    ],
  };

  it('moves an item to a free place, and onto an occupied one swaps the two', () => {
    expect(placesOf(moveItem(inventory, 'cap', 9)!)).toEqual([
      [5, 'boots'],
      [9, 'cap'],
    ]);
    expect(placesOf(moveItem(inventory, 'cap', 5)!)).toEqual([
      [0, 'boots'],
      [5, 'cap'],
    ]);
    expect(moveItem(inventory, 'cap', 0)).toBe(inventory);
  });

  it('refuses an item the dreamer does not have and a place outside the bag', () => {
    expect(moveItem(inventory, 'nothing', 3)).toBeUndefined();
    expect([-1, SOMNIO_PROTOCOL_CONSTANTS.maxBagItems, 1.5].map((place) => moveItem(inventory, 'cap', place))).toEqual([undefined, undefined, undefined]);
  });

  it('puts a worn item away at the place it is moved to, while the bag has room', () => {
    const sword = item('sword', 'sword');
    const wearing: Inventory = { ...inventory, equipped: { mainHand: sword } };
    const moved = moveItem(wearing, 'sword', 7)!;
    expect([moved.equipped, placesOf(moved)]).toEqual([
      {},
      [
        [0, 'cap'],
        [5, 'boots'],
        [7, 'sword'],
      ],
    ]);
    expect(moveItem({ ...wearing, bag: capsOf(SOMNIO_PROTOCOL_CONSTANTS.maxBagItems) }, 'sword', 7)).toBeUndefined();
  });

  it('swaps a worn item with the item at the place it is moved to when that one fits its slot, even in a full bag, and else puts it at the first free place', () => {
    const sword = item('sword', 'sword');
    const dagger = item('dagger', 'dagger');
    const full = capsOf(SOMNIO_PROTOCOL_CONSTANTS.maxBagItems).map((bagged) => (bagged.place === 4 ? { place: 4, item: dagger } : bagged));
    const swapped = moveItem({ coins: 0, equipped: { mainHand: sword }, bag: full }, 'sword', 4)!;
    expect([swapped.equipped.mainHand, swapped.bag.find(({ place }) => place === 4)?.item]).toEqual([dagger, sword]);
    const apart = moveItem({ ...inventory, equipped: { mainHand: sword } }, 'sword', 5)!;
    expect([apart.equipped, placesOf(apart)]).toEqual([
      {},
      [
        [0, 'cap'],
        [1, 'sword'],
        [5, 'boots'],
      ],
    ]);
  });
});

describe('equipping and unequipping', () => {
  it('wears an item from the bag, what the slot wore taking its place there', () => {
    const sword = item('sword', 'sword');
    const dagger = item('dagger', 'dagger');
    const worn = equipItem({ coins: 0, equipped: { mainHand: dagger }, bag: [{ place: 6, item: sword }] }, 'sword')!;
    expect([worn.equipped.mainHand, placesOf(worn)]).toEqual([sword, [[6, 'dagger']]]);
  });

  it('wears a bracelet in the slot asked for, and moves a worn bracelet to the other bracelet slot, the two changing slots', () => {
    const [first, second, third] = [item('bracelet', 'first'), item('bracelet', 'second'), item('bracelet', 'third')];
    expect(equipItem({ coins: 0, equipped: {}, bag: bagOf([first]) }, 'first', 'bracelet2')!.equipped).toEqual({ bracelet2: first });
    expect(equipItem({ coins: 0, equipped: { bracelet1: first }, bag: [] }, 'first', 'bracelet2')!.equipped).toEqual({ bracelet2: first });
    expect(equipItem({ coins: 0, equipped: { bracelet1: first, bracelet2: second }, bag: [] }, 'first', 'bracelet2')!.equipped).toEqual({
      bracelet1: second,
      bracelet2: first,
    });
    expect(equipItem({ coins: 0, equipped: { bracelet1: first, bracelet2: second }, bag: bagOf([third]) }, 'third')!.equipped).toEqual({
      bracelet1: third,
      bracelet2: second,
    });
  });

  it('refuses a slot the base does not fit and an item the dreamer does not have', () => {
    const bracelet = item('bracelet', 'bracelet');
    expect(equipItem({ coins: 0, equipped: {}, bag: bagOf([bracelet]) }, 'bracelet', 'neck')).toBeUndefined();
    expect(equipItem({ coins: 0, equipped: {}, bag: [] }, 'bracelet')).toBeUndefined();
  });

  it('puts a worn item at the first free place, and refuses in a full bag', () => {
    const cap = item('cap', 'cap');
    const off = unequipItem({ coins: 0, equipped: { head: cap }, bag: [{ place: 0, item: item('boots', 'boots') }] }, 'head')!;
    expect([off.equipped, placesOf(off)]).toEqual([
      {},
      [
        [0, 'boots'],
        [1, 'cap'],
      ],
    ]);
    expect(unequipItem({ coins: 0, equipped: { head: cap }, bag: capsOf(SOMNIO_PROTOCOL_CONSTANTS.maxBagItems) }, 'head')).toBeUndefined();
    expect(unequipItem({ coins: 0, equipped: {}, bag: [] }, 'head')).toBeUndefined();
  });
});

describe('the slots', () => {
  it('wear a bracelet on either bracelet slot and every other base in the one slot of its kind', () => {
    expect((['bracelet', 'amulet', 'shoulders', 'tunic', 'trousers', 'sword'] as const).map((baseId) => slotsFor(baseId))).toEqual([
      ['bracelet1', 'bracelet2'],
      ['neck'],
      ['shoulders'],
      ['chest'],
      ['legs'],
      ['mainHand'],
    ]);
  });

  it('equip a bracelet into the free bracelet slot, else into the first, and any other base into its own slot', () => {
    const bracelet = plainInstance('bracelet');
    expect([
      equipSlot({}, 'bracelet'),
      equipSlot({ bracelet1: bracelet }, 'bracelet'),
      equipSlot({ bracelet1: bracelet, bracelet2: bracelet }, 'bracelet'),
      equipSlot({ bracelet2: bracelet }, 'bracelet'),
    ]).toEqual(['bracelet1', 'bracelet2', 'bracelet1', 'bracelet1']);
    expect(equipSlot({ neck: plainInstance('amulet') }, 'amulet')).toBe('neck');
  });
});

describe('the inventory frame', () => {
  const sword = { ...plainInstance('sword'), rarity: 'magic' as const, affixes: [{ affixId: 'damage' as const, value: 2 }] };
  const inventory: Inventory = {
    coins: 42,
    equipped: { bracelet2: plainInstance('bracelet'), offHand: plainInstance('moonstone'), mainHand: sword },
    bag: [{ place: 3, item: plainInstance('cap') }],
  };

  it('carries the worn items in slot order, the bag at its places, and reads back what it carries', () => {
    const message = inventoryMessage(inventory, { trade: { kind: 'bought', baseId: 'cap', tier: 1, rarity: 'plain', coins: 5 } });
    expect(message.equipped.map(({ slot }) => slot)).toEqual(['mainHand', 'offHand', 'bracelet2']);
    expect(message.trade).toEqual({ kind: 'bought', baseId: 'cap', tier: 1, rarity: 'plain', coins: 5 });
    expect(inventoryOf(message)).toEqual(inventory);
  });

  /** Only a build the server's items outrun reads such a frame; it shows what it knows rather than what it would mislabel. */
  it('leaves out an item of an unknown base, tier, or affix, and one worn where its base does not fit', () => {
    const message = inventoryMessage(inventory);
    const bagged = message.bag[0]!;
    const { item: cap } = bagged;
    const read = inventoryOf({
      ...message,
      equipped: [...message.equipped, { slot: 'head', item: { ...cap, baseId: 'sword' } }, { slot: 'neck', item: { ...cap, baseId: 'bracelet' } }],
      bag: [
        bagged,
        { place: 4, item: { ...cap, baseId: 'longsword' } },
        { place: 5, item: { ...cap, tier: 9 } },
        { place: 6, item: { ...cap, affixes: [{ affixId: 'luck', value: 1 }] } },
      ],
    });
    expect(read).toEqual(inventory);
  });

  it('carries what the shopkeeper holds to buy back while he holds anything, and reads back the items it knows, in order', () => {
    expect(inventoryMessage(inventory).buyBack).toBeUndefined();
    expect(buyBackOf(inventoryMessage(inventory))).toEqual([]);
    const cap = plainInstance('cap');
    const message = inventoryMessage(inventory, {}, [sword, cap]);
    expect(buyBackOf(message)).toEqual([sword, cap]);
    expect(buyBackOf({ ...message, buyBack: [...message.buyBack!, { ...message.buyBack![1]!, id: 'other', baseId: 'longsword' }] })).toEqual([sword, cap]);
  });
});
