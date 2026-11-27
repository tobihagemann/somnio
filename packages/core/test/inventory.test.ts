import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import { describe, expect, it } from 'vitest';
import { rollSetPiece } from '../src/affixes.ts';
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
import { hashString, seededSequence } from '../src/hash.ts';
import { equipSlot, commonInstance, slotsFor } from '../src/items.ts';
import type { ItemInstance } from '../src/items.ts';
import { bagOf } from './support/items.ts';

const capsOf = (count: number) => bagOf(Array.from({ length: count }, (_, index) => ({ ...commonInstance('cap'), id: `cap-${index}` })));
const item = (baseId: Parameters<typeof commonInstance>[0], id: string): ItemInstance => ({ ...commonInstance(baseId), id });
const placesOf = (inventory: Inventory) => inventory.bag.map(({ place, item: { id } }) => [place, id]);

describe('the bag', () => {
  it('has room below its cap and none at it', () => {
    expect(bagHasRoom({ coins: 0, equipped: {}, bag: capsOf(SOMNIO_PROTOCOL_CONSTANTS.maxBagItems - 1) })).toBe(true);
    expect(bagHasRoom({ coins: 0, equipped: {}, bag: capsOf(SOMNIO_PROTOCOL_CONSTANTS.maxBagItems) })).toBe(false);
  });

  it('takes a granted item into its empty slot, else into the bag, else nowhere', () => {
    const wand: Inventory['equipped'] = { offHand: commonInstance('wand') };
    expect(grantPlace({ coins: 0, equipped: {}, bag: capsOf(SOMNIO_PROTOCOL_CONSTANTS.maxBagItems) }, 'moonstone')).toBe('offHand');
    expect(grantPlace({ coins: 0, equipped: wand, bag: capsOf(SOMNIO_PROTOCOL_CONSTANTS.maxBagItems - 1) }, 'moonstone')).toBe('bag');
    expect(grantPlace({ coins: 0, equipped: wand, bag: capsOf(SOMNIO_PROTOCOL_CONSTANTS.maxBagItems) }, 'moonstone')).toBeUndefined();
    expect(grantPlace({ coins: 0, equipped: { bracelet1: commonInstance('bracelet') }, bag: capsOf(SOMNIO_PROTOCOL_CONSTANTS.maxBagItems) }, 'bracelet')).toBe(
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
    expect(placesOf(moveItem(inventory, undefined, 'cap', 9)!)).toEqual([
      [5, 'boots'],
      [9, 'cap'],
    ]);
    expect(placesOf(moveItem(inventory, undefined, 'cap', 5)!)).toEqual([
      [0, 'boots'],
      [5, 'cap'],
    ]);
    expect(moveItem(inventory, undefined, 'cap', 0)).toBe(inventory);
  });

  it('refuses an item the dreamer does not have and a place outside the bag', () => {
    expect(moveItem(inventory, undefined, 'nothing', 3)).toBeUndefined();
    expect([-1, SOMNIO_PROTOCOL_CONSTANTS.maxBagItems, 1.5].map((place) => moveItem(inventory, undefined, 'cap', place))).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('puts a worn item away at the place it is moved to, while the bag has room', () => {
    const sword = item('sword', 'sword');
    const wearing: Inventory = { ...inventory, equipped: { mainHand: sword } };
    const moved = moveItem(wearing, undefined, 'sword', 7)!;
    expect([moved.equipped, placesOf(moved)]).toEqual([
      {},
      [
        [0, 'cap'],
        [5, 'boots'],
        [7, 'sword'],
      ],
    ]);
    expect(moveItem({ ...wearing, bag: capsOf(SOMNIO_PROTOCOL_CONSTANTS.maxBagItems) }, undefined, 'sword', 7)).toBeUndefined();
  });

  it('swaps a worn item with the item at the place it is moved to when that one fits its slot, even in a full bag, and else puts it at the first free place', () => {
    const sword = item('sword', 'sword');
    const dagger = item('dagger', 'dagger');
    const full = capsOf(SOMNIO_PROTOCOL_CONSTANTS.maxBagItems).map((bagged) => (bagged.place === 4 ? { place: 4, item: dagger } : bagged));
    const swapped = moveItem({ coins: 0, equipped: { mainHand: sword }, bag: full }, undefined, 'sword', 4)!;
    expect([swapped.equipped.mainHand, swapped.bag.find(({ place }) => place === 4)?.item]).toEqual([dagger, sword]);
    const apart = moveItem({ ...inventory, equipped: { mainHand: sword } }, undefined, 'sword', 5)!;
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
    const worn = equipItem({ coins: 0, equipped: { mainHand: dagger }, bag: [{ place: 6, item: sword }] }, undefined, 'sword')!;
    expect([worn.equipped.mainHand, placesOf(worn)]).toEqual([sword, [[6, 'dagger']]]);
  });

  it('wears a bracelet in the slot asked for, and moves a worn bracelet to the other bracelet slot, the two changing slots', () => {
    const [first, second, third] = [item('bracelet', 'first'), item('bracelet', 'second'), item('bracelet', 'third')];
    expect(equipItem({ coins: 0, equipped: {}, bag: bagOf([first]) }, undefined, 'first', 'bracelet2')!.equipped).toEqual({ bracelet2: first });
    expect(equipItem({ coins: 0, equipped: { bracelet1: first }, bag: [] }, undefined, 'first', 'bracelet2')!.equipped).toEqual({ bracelet2: first });
    expect(equipItem({ coins: 0, equipped: { bracelet1: first, bracelet2: second }, bag: [] }, undefined, 'first', 'bracelet2')!.equipped).toEqual({
      bracelet1: second,
      bracelet2: first,
    });
    expect(equipItem({ coins: 0, equipped: { bracelet1: first, bracelet2: second }, bag: bagOf([third]) }, undefined, 'third')!.equipped).toEqual({
      bracelet1: third,
      bracelet2: second,
    });
  });

  it('refuses a slot the base does not fit and an item the dreamer does not have', () => {
    const bracelet = item('bracelet', 'bracelet');
    expect(equipItem({ coins: 0, equipped: {}, bag: bagOf([bracelet]) }, undefined, 'bracelet', 'neck')).toBeUndefined();
    expect(equipItem({ coins: 0, equipped: {}, bag: [] }, undefined, 'bracelet')).toBeUndefined();
  });

  it('puts a worn item at the first free place, and refuses in a full bag', () => {
    const cap = item('cap', 'cap');
    const off = unequipItem({ coins: 0, equipped: { head: cap }, bag: [{ place: 0, item: item('boots', 'boots') }] }, undefined, 'head')!;
    expect([off.equipped, placesOf(off)]).toEqual([
      {},
      [
        [0, 'boots'],
        [1, 'cap'],
      ],
    ]);
    expect(unequipItem({ coins: 0, equipped: { head: cap }, bag: capsOf(SOMNIO_PROTOCOL_CONSTANTS.maxBagItems) }, undefined, 'head')).toBeUndefined();
    expect(unequipItem({ coins: 0, equipped: {}, bag: [] }, undefined, 'head')).toBeUndefined();
  });
});

describe('the wear rule', () => {
  const cap = item('cap', 'cap');
  const wimple = { id: 'wimple', ...rollSetPiece('cap', 3, 'healer', seededSequence(hashString('wimple'))) };
  const inventory: Inventory = { coins: 0, equipped: { head: cap }, bag: [{ place: 4, item: wimple }] };
  const swapped = { coins: 0, equipped: { head: wimple }, bag: [{ place: 4, item: cap }] };

  it("wears a set piece only for its line's role, from the bag and in a worn piece's swap alike", () => {
    for (const role of ['fighter', 'mystic', undefined] as const) {
      expect([equipItem(inventory, role, 'wimple'), unequipItem(inventory, role, 'head', 4), moveItem(inventory, role, 'cap', 4)]).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
    }
    expect([equipItem(inventory, 'healer', 'wimple'), unequipItem(inventory, 'healer', 'head', 4), moveItem(inventory, 'healer', 'cap', 4)]).toEqual([
      swapped,
      swapped,
      swapped,
    ]);
  });

  it('moves a set piece between bag places for any role', () => {
    for (const role of ['fighter', 'healer', 'mystic', undefined] as const) expect(placesOf(moveItem(inventory, role, 'wimple', 9)!)).toEqual([[9, 'wimple']]);
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
    const bracelet = commonInstance('bracelet');
    expect([
      equipSlot({}, 'bracelet'),
      equipSlot({ bracelet1: bracelet }, 'bracelet'),
      equipSlot({ bracelet1: bracelet, bracelet2: bracelet }, 'bracelet'),
      equipSlot({ bracelet2: bracelet }, 'bracelet'),
    ]).toEqual(['bracelet1', 'bracelet2', 'bracelet1', 'bracelet1']);
    expect(equipSlot({ neck: commonInstance('amulet') }, 'amulet')).toBe('neck');
  });
});

describe('the inventory frame', () => {
  const sword = { ...commonInstance('sword'), rarity: 'uncommon' as const, affixes: [{ affixId: 'damage' as const, value: 2 }] };
  const wimple = { id: 'wimple', ...rollSetPiece('cap', 3, 'healer', seededSequence(hashString('wimple'))) };
  const inventory: Inventory = {
    coins: 42,
    equipped: { bracelet2: commonInstance('bracelet'), offHand: commonInstance('moonstone'), mainHand: sword },
    bag: [
      { place: 3, item: commonInstance('cap') },
      { place: 4, item: wimple },
    ],
  };

  it('carries the worn items in slot order, the bag at its places, and reads back what it carries', () => {
    const message = inventoryMessage(inventory, { trade: { kind: 'bought', baseId: 'cap', tier: 1, rarity: 'common', coins: 5 } });
    expect(message.equipped.map(({ slot }) => slot)).toEqual(['mainHand', 'offHand', 'bracelet2']);
    expect(message.bag.map(({ item }) => item.line)).toEqual([undefined, 'healer']);
    expect(message.trade).toEqual({ kind: 'bought', baseId: 'cap', tier: 1, rarity: 'common', coins: 5 });
    expect(inventoryOf(message)).toEqual(inventory);
  });

  /** Only a build the server's items outrun reads such a frame; it shows what it knows rather than what it would mislabel. */
  it('leaves out an item of an unknown base, tier, or affix, one worn where its base does not fit, and a set piece at a tier with no design', () => {
    const message = inventoryMessage(inventory);
    const { item: cap } = message.bag[0]!;
    const { item: setPiece } = message.bag[1]!;
    const read = inventoryOf({
      ...message,
      equipped: [...message.equipped, { slot: 'head', item: { ...cap, baseId: 'sword' } }, { slot: 'neck', item: { ...cap, baseId: 'bracelet' } }],
      bag: [
        ...message.bag,
        { place: 5, item: { ...cap, baseId: 'longsword' } },
        { place: 6, item: { ...cap, tier: 9 } },
        { place: 7, item: { ...cap, affixes: [{ affixId: 'luck', value: 1 }] } },
        { place: 8, item: { ...setPiece, id: 'tier-1-wimple', tier: 1 } },
      ],
    });
    expect(read).toEqual(inventory);
  });

  it('carries what the shopkeeper holds to buy back while he holds anything, and reads back the items it knows, in order', () => {
    expect(inventoryMessage(inventory).buyBack).toBeUndefined();
    expect(buyBackOf(inventoryMessage(inventory))).toEqual([]);
    const cap = commonInstance('cap');
    const message = inventoryMessage(inventory, {}, [sword, cap]);
    expect(buyBackOf(message)).toEqual([sword, cap]);
    expect(buyBackOf({ ...message, buyBack: [...message.buyBack!, { ...message.buyBack![1]!, id: 'other', baseId: 'longsword' }] })).toEqual([sword, cap]);
  });
});
