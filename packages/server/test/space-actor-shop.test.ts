import { describe, expect, it } from 'vitest';
import type { Character, InventoryRow, Point, Sector } from '@somnio/core';
import { CUDGEL_IN_HAND, MONDSTEIN_IN_HAND, PURSE, arena, characterOf, energy, lucidity, payloads } from './support/combat.ts';
import { collectMessages } from './support/frames.ts';
import { attachPlayer, makeNPC } from './support/sectorFactory.ts';

const MERCUS = 'npc:TestSector/mercus';
const PUGNAX = 'npc:TestSector/pugnax';
const AT_MERCUS: Point = { x: 4, z: 5 };
const AT_PUGNAX: Point = { x: 16, z: 5 };

const SHOP_FLOOR: Partial<Sector> = {
  npcs: [
    { ...makeNPC('mercus', { x: 4, z: 4 }, ''), service: 'shopkeeper' },
    { ...makeNPC('pugnax', { x: 16, z: 4 }, ''), service: 'kaempferMaster' },
  ],
};

function shop(at: Point = AT_MERCUS, options: { inventory?: InventoryRow[]; character?: Partial<Character> } = {}) {
  const world = arena(SHOP_FLOOR, { ghost: false });
  const dreamer = attachPlayer(world.space, at, 'dreamer', { inventory: options.inventory ?? [PURSE, CUDGEL_IN_HAND], ...options });
  const inventory = () => world.space.snapshotForPlayer(dreamer.entityId)!.inventory;
  /** Every `inventory` frame after the join's, read once: reading finishes the outbox. */
  const framesAfterJoin = async () => payloads(await collectMessages(dreamer.outbox), 'inventory').slice(1);
  return { world, dreamer, inventory, framesAfterJoin };
}

type Shop = ReturnType<typeof shop>;

describe('buying from the shopkeeper', () => {
  it('takes the price from the purse and adds the ware, in one frame that says what was bought', async () => {
    const s = shop();
    s.world.space.handleBuy(MERCUS, 'dagger', s.dreamer.entityId);
    expect(s.inventory()).toEqual([{ ...PURSE, quantity: 40 }, CUDGEL_IN_HAND, { slot: 2, itemId: 'dagger', quantity: 1, equippedHand: undefined }]);
    expect(await s.framesAfterJoin()).toEqual([
      {
        rows: [
          { slot: 0, itemId: 'purse', quantity: 40 },
          { slot: 1, itemId: 'cudgel', quantity: 1, equippedHand: 'right' },
          { slot: 2, itemId: 'dagger', quantity: 1 },
        ],
        trade: { kind: 'bought', itemId: 'dagger', coins: 60 },
      },
    ]);
  });

  it.each<[string, Point, string, string, { inventory?: InventoryRow[]; character?: Partial<Character> }]>([
    ['from beyond speaking distance', { x: 4, z: 6.1 }, MERCUS, 'dagger', {}],
    ['by a fallen dreamer', AT_MERCUS, MERCUS, 'dagger', { character: { energy: energy({ healthCurrent: 0 }) } }],
    ['at a master', AT_PUGNAX, PUGNAX, 'dagger', {}],
    ['of the purse', AT_MERCUS, MERCUS, 'purse', {}],
    ['of the Mondstein', AT_MERCUS, MERCUS, 'mondstein', {}],
    ['of an item nobody sells', AT_MERCUS, MERCUS, 'lantern', {}],
    ['of a weapon already carried', AT_MERCUS, MERCUS, 'cudgel', {}],
    ['for a purse too short', AT_MERCUS, MERCUS, 'sword', {}],
  ])('changes nothing and sends nothing %s', async (_label, at, npcId, itemId, options) => {
    const s = shop(at, options);
    const before = s.inventory();
    s.world.space.handleBuy(npcId, itemId, s.dreamer.entityId);
    expect(s.inventory()).toEqual(before);
    expect(await s.framesAfterJoin()).toEqual([]);
  });
});

describe('selling to the shopkeeper', () => {
  it('buys back the weapon in hand for half its price, leaving the hand empty, in one frame that says what was sold', async () => {
    const s = shop();
    s.world.space.handleSell(MERCUS, 'cudgel', s.dreamer.entityId);
    expect(s.inventory()).toEqual([{ ...PURSE, quantity: 115 }]);
    expect(await s.framesAfterJoin()).toEqual([{ rows: [{ slot: 0, itemId: 'purse', quantity: 115 }], trade: { kind: 'sold', itemId: 'cudgel', coins: 15 } }]);
  });

  it('leaves the weapon in hand where it is when a ware from the bag sells', async () => {
    const dagger: InventoryRow = { slot: 2, itemId: 'dagger', quantity: 1, equippedHand: undefined };
    const s = shop(AT_MERCUS, { inventory: [PURSE, CUDGEL_IN_HAND, dagger] });
    s.world.space.handleSell(MERCUS, 'dagger', s.dreamer.entityId);
    expect(s.inventory()).toEqual([{ ...PURSE, quantity: 130 }, CUDGEL_IN_HAND]);
    expect((await s.framesAfterJoin()).map((frame) => frame.trade)).toEqual([{ kind: 'sold', itemId: 'dagger', coins: 30 }]);
  });

  it.each<[string, Point, string, string, InventoryRow[]]>([
    ['from beyond speaking distance', { x: 4, z: 6.1 }, MERCUS, 'cudgel', [PURSE, CUDGEL_IN_HAND]],
    ['at a master', AT_PUGNAX, PUGNAX, 'cudgel', [PURSE, CUDGEL_IN_HAND]],
    ['of the purse', AT_MERCUS, MERCUS, 'purse', [PURSE, CUDGEL_IN_HAND]],
    ['of the Mondstein', AT_MERCUS, MERCUS, 'mondstein', [PURSE, MONDSTEIN_IN_HAND]],
    ['of a weapon not carried', AT_MERCUS, MERCUS, 'mace', [PURSE, CUDGEL_IN_HAND]],
  ])('changes nothing and sends nothing %s', async (_label, at, npcId, itemId, inventory) => {
    const s = shop(at, { inventory });
    s.world.space.handleSell(npcId, itemId, s.dreamer.entityId);
    expect(s.inventory()).toEqual(inventory);
    expect(await s.framesAfterJoin()).toEqual([]);
  });

  it('changes nothing for a fallen dreamer', () => {
    const s = shop(AT_MERCUS, { character: { energy: energy({ healthCurrent: 0 }) } });
    s.world.space.handleSell(MERCUS, 'cudgel', s.dreamer.entityId);
    expect(s.inventory()).toEqual([PURSE, CUDGEL_IN_HAND]);
  });
});

describe('the shopkeeper', () => {
  const passed: Partial<Character> = { lucidity: lucidity(undefined, {}, { task: { role: 'kaempfer', teachingId: undefined, progress: 1 } }) };

  it.each<[string, Partial<Character>, (space: Shop['world']['space'], entityId: string) => void]>([
    ['sets no trial', {}, (space, entityId) => space.handleAskTask(MERCUS, undefined, entityId)],
    ['takes no trial as done', passed, (space, entityId) => space.handleCompleteTask(MERCUS, entityId)],
    ['sets no teaching to study', { lucidity: lucidity('kaempfer', { strike: 1 }) }, (space, entityId) => space.handleStudy(MERCUS, 'guard', entityId)],
  ])('%s', (_label, character, request) => {
    const s = shop(AT_MERCUS, { character });
    const before = characterOf(s.world.space, s.dreamer.entityId).lucidity;
    request(s.world.space, s.dreamer.entityId);
    expect(characterOf(s.world.space, s.dreamer.entityId).lucidity).toEqual(before);
  });
});
