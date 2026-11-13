import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InventoryMessage } from '@somnio/protocol';
import { PostgresCharacterRepository, PostgresItemRepository } from '@somnio/data';
import { bootTestServer, closeAndAwaitCleanup, frame, joinFreshPlayer, loginOverWire, pollUntil, startDatabase } from './support/harness.ts';
import type { DatabaseHarness, JoinedClient, TestServer } from './support/harness.ts';

let harness: DatabaseHarness;
let server: TestServer;

beforeAll(async () => {
  harness = await startDatabase();
  server = await bootTestServer(harness.url);
});
afterAll(async () => {
  await server.stop();
  await harness.stop();
});

function joinInventory(joined: JoinedClient): InventoryMessage {
  const inventory = joined.join.find((message) => message.tag === 'inventory');
  if (inventory?.tag !== 'inventory') throw new Error('join carried no inventory');
  return inventory.payload;
}

async function persistedMainHand(name: string) {
  const character = await new PostgresCharacterRepository(harness.db).findByName(name);
  return (await new PostgresItemRepository(harness.db).load(character!.id)).equipped.mainHand?.baseId;
}

describe('inventory round trip', () => {
  it('register then login surfaces the starter inventory in the inventory frame', async () => {
    const joined = await joinFreshPlayer(server.url, 'starter');
    expect(joinInventory(joined)).toEqual({
      coins: 100,
      equipped: [{ slot: 'mainHand', item: { id: expect.any(String), baseId: 'cudgel', tier: 1, rarity: 'plain', affixes: [] } }],
      bag: [],
    });
    await joined.client.close();
  });

  it('unequip lays the cudgel in the bag, equip wears it again, and each re-emits the inventory', async () => {
    const joined = await joinFreshPlayer(server.url, 'equipper');
    const cudgel = joinInventory(joined).equipped[0]!.item;
    joined.client.send(frame({ tag: 'unequip', payload: { slot: 'mainHand' } }));
    const unequipped = await joined.client.until('inventory');
    expect(unequipped.target.tag === 'inventory' ? unequipped.target.payload : undefined).toEqual({
      coins: 100,
      equipped: [],
      bag: [{ place: 0, item: cudgel }],
    });
    joined.client.send(frame({ tag: 'equip', payload: { itemId: cudgel.id } }));
    const equipped = await joined.client.until('inventory');
    expect(equipped.target.tag === 'inventory' ? equipped.target.payload : undefined).toEqual({
      coins: 100,
      equipped: [{ slot: 'mainHand', item: cudgel }],
      bag: [],
    });
    await joined.client.close();
  });

  it('equip state and bag places are persisted by the close checkpoint and surface on reconnect', async () => {
    const joined = await joinFreshPlayer(server.url, 'persister');
    const cudgel = joinInventory(joined).equipped[0]!.item;
    joined.client.send(frame({ tag: 'unequip', payload: { slot: 'mainHand' } }));
    await joined.client.until('inventory');
    joined.client.send(frame({ tag: 'moveItem', payload: { itemId: cudgel.id, place: 7 } }));
    await joined.client.until('inventory');
    await closeAndAwaitCleanup(joined, server);
    expect(await pollUntil(async () => ((await persistedMainHand(joined.name)) === undefined ? true : undefined))).toBe(true);

    const second = await loginOverWire(server.url, joined.name);
    expect(joinInventory(second)).toMatchObject({ equipped: [], bag: [{ place: 7, item: cudgel }] });
    second.client.send(frame({ tag: 'equip', payload: { itemId: cudgel.id } }));
    await second.client.until('inventory');
    await closeAndAwaitCleanup(second, server);
    expect(await pollUntil(async () => ((await persistedMainHand(joined.name)) === 'cudgel' ? true : undefined))).toBe(true);

    const third = await loginOverWire(server.url, joined.name);
    expect(joinInventory(third)).toMatchObject({ equipped: [{ slot: 'mainHand', item: cudgel }], bag: [] });
    await third.client.close();
  });
});
