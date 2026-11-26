import { describe, expect, it } from 'vitest';
import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import { inventoryMessage } from '@somnio/core';
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
  npcs: [makeNPC('mercus', { x: 4, z: 4 }, {}, 'shopkeeper'), makeNPC('pugnax', { x: 16, z: 4 }, {}, 'fighterMaster')],
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
        trade: { kind: 'bought', baseId: 'dagger', tier: 1, rarity: 'plain', coins: 60 },
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
  it('buys a plain item from the bag for half its value, in one frame that says what was sold and holds it to buy back', async () => {
    const s = shop(AT_MERCUS, { inventory: CUDGEL_IN_BAG });
    s.world.space.handleSell(MERCUS, CUDGEL.id, s.dreamer.entityId);
    expect(s.inventory()).toEqual({ coins: 115, equipped: {}, bag: [] });
    expect(await s.framesAfterJoin()).toEqual([
      { coins: 115, equipped: [], bag: [], trade: { kind: 'sold', baseId: 'cudgel', tier: 1, rarity: 'plain', coins: 15 }, buyBack: [CUDGEL] },
    ]);
  });

  it('pays a plain sword 75', () => {
    const sword: ItemInstance = { id: '00000000-0000-7000-8000-000000000006', ...plain('sword') };
    const s = shop(AT_MERCUS, { inventory: carrying({ bag: [sword] }) });
    s.world.space.handleSell(MERCUS, sword.id, s.dreamer.entityId);
    expect(s.inventory().coins).toBe(75);
  });

  it('pays for a rare item by its value, its rolled lines with it, and leaves the weapon in hand where it is', async () => {
    const s = shop(AT_MERCUS, { inventory: carrying({ coins: COINS, worn: [CUDGEL], bag: [DAGGER, RARE_AMULET] }) });
    s.world.space.handleSell(MERCUS, RARE_AMULET.id, s.dreamer.entityId);
    expect(s.inventory()).toEqual(carrying({ coins: 173, worn: [CUDGEL], bag: [DAGGER] }));
    expect((await s.framesAfterJoin()).map((frame) => frame.trade)).toEqual([{ kind: 'sold', baseId: 'amulet', tier: 1, rarity: 'rare', coins: 73 }]);
  });

  it('holds what was sold newest first, and no more than the cap', async () => {
    const caps = FULL_BAG.slice(0, SOMNIO_PROTOCOL_CONSTANTS.maxBuyBackItems + 1);
    const s = shop(AT_MERCUS, { inventory: carrying({ bag: caps }) });
    for (const cap of caps) s.world.space.handleSell(MERCUS, cap.id, s.dreamer.entityId);
    const frames = await s.framesAfterJoin();
    expect(frames[0]!.buyBack).toEqual([caps[0]]);
    expect(frames.at(-1)!.buyBack).toEqual(caps.slice(1).reverse());
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

describe('buying back from the shopkeeper', () => {
  /** A dreamer who sold the rare amulet and the dagger, the dagger last. */
  function sold(inventory: Inventory = carrying({ coins: COINS, worn: [CUDGEL], bag: [DAGGER, RARE_AMULET] })) {
    const s = shop(AT_MERCUS, { inventory });
    s.world.space.handleSell(MERCUS, RARE_AMULET.id, s.dreamer.entityId);
    s.world.space.handleSell(MERCUS, DAGGER.id, s.dreamer.entityId);
    return s;
  }

  it('gives the item back as it was, under its own id, for what he paid, in one frame that says so', async () => {
    const s = sold();
    s.world.space.handleBuyBack(MERCUS, RARE_AMULET.id, s.dreamer.entityId);
    expect(s.inventory()).toEqual(carrying({ coins: 130, worn: [CUDGEL], bag: [RARE_AMULET] }));
    const frames = await s.framesAfterJoin();
    expect(frames.at(-1)).toEqual({
      coins: 130,
      equipped: [{ slot: 'mainHand', item: CUDGEL }],
      bag: [{ place: 0, item: RARE_AMULET }],
      trade: { kind: 'boughtBack', baseId: 'amulet', tier: 1, rarity: 'rare', coins: 73 },
      buyBack: [DAGGER],
    });
  });

  it('says the tier of the item sold and bought back, not that of a like item worn', async () => {
    const worn: ItemInstance = { id: '00000000-0000-7000-8000-000000000007', ...plain('tunic') };
    const finer: ItemInstance = { id: '00000000-0000-7000-8000-000000000008', ...plain('tunic'), tier: 3 };
    const s = shop(AT_MERCUS, { inventory: carrying({ worn: [worn], bag: [finer] }) });
    s.world.space.handleSell(MERCUS, finer.id, s.dreamer.entityId);
    s.world.space.handleBuyBack(MERCUS, finer.id, s.dreamer.entityId);
    expect((await s.framesAfterJoin()).map(({ trade }) => [trade?.kind, trade?.tier])).toEqual([
      ['sold', 3],
      ['boughtBack', 3],
    ]);
  });

  it('leaves the frame without the list once he holds nothing to buy back', async () => {
    const s = sold();
    s.world.space.handleBuyBack(MERCUS, RARE_AMULET.id, s.dreamer.entityId);
    s.world.space.handleBuyBack(MERCUS, DAGGER.id, s.dreamer.entityId);
    expect((await s.framesAfterJoin()).at(-1)).not.toHaveProperty('buyBack');
  });

  /**
   * Asks for an item back and expects nothing to change and no frame to answer: the `inventory`
   * frames after the join's are the `before` ones the setup sent. Returns them.
   */
  async function refused(s: Shop, before: number, carrierId = MERCUS, itemId = RARE_AMULET.id) {
    const held = s.inventory();
    s.world.space.handleBuyBack(carrierId, itemId, s.dreamer.entityId);
    expect(s.inventory()).toEqual(held);
    const frames = await s.framesAfterJoin();
    expect(frames).toHaveLength(before);
    return frames;
  }

  it('changes nothing and sends nothing into a full bag', async () => {
    const s = sold(carrying({ coins: COINS, bag: [...FULL_BAG.slice(2), DAGGER, RARE_AMULET] }));
    s.world.space.handleBuy(MERCUS, 'cap', s.dreamer.entityId);
    s.world.space.handleBuy(MERCUS, 'cap', s.dreamer.entityId);
    await refused(s, 4);
  });

  it('changes nothing and sends nothing for a purse too short', async () => {
    const s = sold(carrying({ bag: [DAGGER, RARE_AMULET] }));
    s.world.space.handleBuy(MERCUS, 'dagger', s.dreamer.entityId);
    await refused(s, 3);
  });

  it('changes nothing and sends nothing for an item he does not hold', async () => {
    await refused(sold(), 2, MERCUS, CUDGEL.id);
  });

  it('changes nothing and sends nothing at a master', async () => {
    const world = arena({ npcs: [...SHOP_FLOOR.npcs!.slice(0, 1), makeNPC('pugnax', { x: 5, z: 4 }, {}, 'fighterMaster')] }, { ghost: false });
    const dreamer = attachPlayer(world.space, AT_MERCUS, 'dreamer', { inventory: carrying({ coins: COINS, bag: [RARE_AMULET] }) });
    world.space.handleSell(MERCUS, RARE_AMULET.id, dreamer.entityId);
    const s: Shop = {
      world,
      dreamer,
      inventory: () => world.space.snapshotForPlayer(dreamer.entityId)!.inventory,
      framesAfterJoin: async () => payloads(await collectMessages(dreamer.outbox), 'inventory').slice(1),
    };
    await refused(s, 1, PUGNAX);
  });

  it('holds nothing for a dreamer who left the space and came back', async () => {
    const s = sold();
    const { checkpoint, transient } = s.world.space.handOver(s.dreamer.entityId, false)!;
    s.world.space.attach(checkpoint.character, checkpoint.inventory, s.dreamer.outbox, 0, 'en', transient);
    expect((await refused(s, 3, MERCUS, DAGGER.id)).at(-1)).toEqual(inventoryMessage(checkpoint.inventory));
  });

  it('checkpoints the purse and the bag as a sale and a buy-back left them', () => {
    const s = sold();
    const checkpointed = () => s.world.space.snapshotForCheckpoint().find(({ character }) => character.id === s.dreamer.entityId)!.inventory;
    expect(checkpointed()).toEqual(carrying({ coins: 203, worn: [CUDGEL] }));
    s.world.space.handleBuyBack(MERCUS, RARE_AMULET.id, s.dreamer.entityId);
    expect(checkpointed()).toEqual(carrying({ coins: 130, worn: [CUDGEL], bag: [RARE_AMULET] }));
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
