import { describe, expect, it } from 'vitest';
import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import type { Character, Inventory, ItemInstance, Point, Sector } from '@somnio/core';
import { plain } from '../../core/test/support/items.ts';
import { COINS, CUDGEL, MOONSTONE, arena, carrying, characterOf, energy, lucidity, payloads } from './support/combat.ts';
import { collectMessages } from './support/frames.ts';
import { attachPlayer, makeNPC } from './support/sectorFactory.ts';

const MERCUS = 'npc:TestSector/mercus';
const PUGNAX = 'npc:TestSector/pugnax';
const AT_MERCUS: Point = { x: 4, z: 5 };
const AT_PUGNAX: Point = { x: 16, z: 5 };
const DAGGER: ItemInstance = { id: '00000000-0000-7000-8000-000000000004', ...plain('dagger') };
const RARE_AMULET: ItemInstance = {
  id: '00000000-0000-7000-8000-000000000005',
  ...plain('amulet'),
  rarity: 'rare',
  affixes: [
    { affixId: 'health', value: 4 },
    { affixId: 'spirit', value: 6 },
    { affixId: 'damage', value: 2 },
  ],
};
const CUDGEL_IN_HAND = carrying({ coins: COINS, worn: [CUDGEL] });
const CUDGEL_IN_BAG = carrying({ coins: COINS, bag: [CUDGEL] });
/** A bag with no room left, of caps. */
const FULL_BAG: ItemInstance[] = Array.from({ length: SOMNIO_PROTOCOL_CONSTANTS.maxBagItems }, (_, index) => ({
  id: `00000000-0000-7000-8000-1${String(index).padStart(11, '0')}`,
  ...plain('cap'),
}));

const SHOP_FLOOR: Partial<Sector> = {
  npcs: [
    { ...makeNPC('mercus', { x: 4, z: 4 }, ''), service: 'shopkeeper' },
    { ...makeNPC('pugnax', { x: 16, z: 4 }, ''), service: 'fighterMaster' },
  ],
};

function shop(at: Point = AT_MERCUS, options: { inventory?: Inventory; character?: Partial<Character> } = {}) {
  const world = arena(SHOP_FLOOR, { ghost: false });
  const dreamer = attachPlayer(world.space, at, 'dreamer', { inventory: options.inventory ?? CUDGEL_IN_HAND, ...options });
  const inventory = () => world.space.snapshotForPlayer(dreamer.entityId)!.inventory;
  /** Every `inventory` frame after the join's, read once: reading finishes the outbox. */
  const framesAfterJoin = async () => payloads(await collectMessages(dreamer.outbox), 'inventory').slice(1);
  return { world, dreamer, inventory, framesAfterJoin };
}

type Shop = ReturnType<typeof shop>;

describe('buying from the shopkeeper', () => {
  it('takes the price from the purse and adds a plain one of the ware to the bag, in one frame that says what was bought', async () => {
    const s = shop();
    s.world.space.handleBuy(MERCUS, 'dagger', s.dreamer.entityId);
    expect(s.inventory()).toEqual({ coins: 40, equipped: { mainHand: CUDGEL }, bag: [{ place: 0, item: { id: expect.any(String), ...plain('dagger') } }] });
    const bought = s.inventory().bag[0]!;
    expect(await s.framesAfterJoin()).toEqual([
      {
        coins: 40,
        equipped: [{ slot: 'mainHand', item: CUDGEL }],
        bag: [bought],
        trade: { kind: 'bought', baseId: 'dagger', rarity: 'plain', coins: 60 },
      },
    ]);
  });

  it('sells another of a ware the dreamer already carries', () => {
    const s = shop();
    s.world.space.handleBuy(MERCUS, 'cudgel', s.dreamer.entityId);
    expect(s.inventory()).toEqual({ coins: 70, equipped: { mainHand: CUDGEL }, bag: [{ place: 0, item: { id: expect.any(String), ...plain('cudgel') } }] });
  });

  it.each<[string, Point, string, string, { inventory?: Inventory; character?: Partial<Character> }]>([
    ['from beyond speaking distance', { x: 4, z: 6.1 }, MERCUS, 'dagger', {}],
    ['by a fallen dreamer', AT_MERCUS, MERCUS, 'dagger', { character: { energy: energy({ healthCurrent: 0 }) } }],
    ['at a master', AT_PUGNAX, PUGNAX, 'dagger', {}],
    ['of the purse', AT_MERCUS, MERCUS, 'purse', {}],
    ['of the Moonstone', AT_MERCUS, MERCUS, 'moonstone', {}],
    ['of an item nobody sells', AT_MERCUS, MERCUS, 'lantern', {}],
    ['for a purse too short', AT_MERCUS, MERCUS, 'sword', {}],
    ['into a full bag', AT_MERCUS, MERCUS, 'dagger', { inventory: carrying({ coins: COINS, bag: FULL_BAG }) }],
  ])('changes nothing and sends nothing %s', async (_label, at, npcId, baseId, options) => {
    const s = shop(at, options);
    const before = s.inventory();
    s.world.space.handleBuy(npcId, baseId, s.dreamer.entityId);
    expect(s.inventory()).toEqual(before);
    expect(await s.framesAfterJoin()).toEqual([]);
  });
});

describe('selling to the shopkeeper', () => {
  it('buys a plain item from the bag for the plain price, in one frame that says what was sold', async () => {
    const s = shop(AT_MERCUS, { inventory: CUDGEL_IN_BAG });
    s.world.space.handleSell(MERCUS, CUDGEL.id, s.dreamer.entityId);
    expect(s.inventory()).toEqual({ coins: 110, equipped: {}, bag: [] });
    expect(await s.framesAfterJoin()).toEqual([{ coins: 110, equipped: [], bag: [], trade: { kind: 'sold', baseId: 'cudgel', rarity: 'plain', coins: 10 } }]);
  });

  it('buys a rare item for the rare price, and leaves the weapon in hand where it is', async () => {
    const s = shop(AT_MERCUS, { inventory: carrying({ coins: COINS, worn: [CUDGEL], bag: [DAGGER, RARE_AMULET] }) });
    s.world.space.handleSell(MERCUS, RARE_AMULET.id, s.dreamer.entityId);
    expect(s.inventory()).toEqual(carrying({ coins: 175, worn: [CUDGEL], bag: [DAGGER] }));
    expect((await s.framesAfterJoin()).map((frame) => frame.trade)).toEqual([{ kind: 'sold', baseId: 'amulet', rarity: 'rare', coins: 75 }]);
  });

  it.each<[string, Point, string, string, Inventory]>([
    ['from beyond speaking distance', { x: 4, z: 6.1 }, MERCUS, CUDGEL.id, CUDGEL_IN_BAG],
    ['at a master', AT_PUGNAX, PUGNAX, CUDGEL.id, CUDGEL_IN_BAG],
    ['of the weapon in hand', AT_MERCUS, MERCUS, CUDGEL.id, CUDGEL_IN_HAND],
    ['of the Moonstone', AT_MERCUS, MERCUS, MOONSTONE.id, carrying({ coins: COINS, bag: [MOONSTONE] })],
    ['of an item not carried', AT_MERCUS, MERCUS, DAGGER.id, CUDGEL_IN_BAG],
  ])('changes nothing and sends nothing %s', async (_label, at, npcId, itemId, inventory) => {
    const s = shop(at, { inventory });
    s.world.space.handleSell(npcId, itemId, s.dreamer.entityId);
    expect(s.inventory()).toEqual(inventory);
    expect(await s.framesAfterJoin()).toEqual([]);
  });

  it('changes nothing for a fallen dreamer', () => {
    const s = shop(AT_MERCUS, { inventory: CUDGEL_IN_BAG, character: { energy: energy({ healthCurrent: 0 }) } });
    s.world.space.handleSell(MERCUS, CUDGEL.id, s.dreamer.entityId);
    expect(s.inventory()).toEqual(CUDGEL_IN_BAG);
  });
});

describe('the shopkeeper', () => {
  const passed: Partial<Character> = { quests: { active: [{ questId: 'fighter-trial', progress: [1] }], done: [] } };

  it.each<[string, Partial<Character>, (space: Shop['world']['space'], entityId: string) => void]>([
    ['gives no trial', {}, (space, entityId) => space.handleAcceptQuest(MERCUS, 'fighter-trial', entityId)],
    ['takes no trial in', passed, (space, entityId) => space.handleTurnInQuest(MERCUS, 'fighter-trial', entityId)],
    ['sets no teaching to study', { lucidity: lucidity('fighter', { strike: 1 }) }, (space, entityId) => space.handleStudy(MERCUS, 'guard', entityId)],
  ])('%s', (_label, character, request) => {
    const s = shop(AT_MERCUS, { character });
    const { lucidity: before, quests } = characterOf(s.world.space, s.dreamer.entityId);
    request(s.world.space, s.dreamer.entityId);
    expect(characterOf(s.world.space, s.dreamer.entityId)).toMatchObject({ lucidity: before, quests });
  });
});
