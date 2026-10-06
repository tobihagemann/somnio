import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Character, InventoryRow, Lucidity } from '@somnio/core';
import { PostgresCharacterRepository, PostgresInventoryRepository } from '@somnio/data';
import { bootTestServer, closeAndAwaitCleanup, drainFrames, frame, joinFreshPlayer, loginOverWire, pollUntil, startDatabase } from './support/harness.ts';
import type { DatabaseHarness, TestServer } from './support/harness.ts';

let harness: DatabaseHarness;
let server: TestServer;
let characters: PostgresCharacterRepository;

beforeAll(async () => {
  harness = await startDatabase();
  // No simulation step runs inside the suite, so no pool recovers under the assertions.
  server = await bootTestServer(harness.url, { simulationIntervalMs: 3_600_000 });
  characters = new PostgresCharacterRepository(harness.db);
});
afterAll(async () => {
  await server.stop();
  await harness.stop();
});

/** Registers a player, lets them leave, and writes `changes` over their row as a later checkpoint would. */
async function seeded(prefix: string, changes: Partial<Character>, inventory: InventoryRow[]): Promise<Character> {
  const fresh = await joinFreshPlayer(server.url, prefix);
  const registered = (await characters.findByName(fresh.nickname))!;
  await closeAndAwaitCleanup(fresh, server);
  const left = await pollUntil(async () => {
    const row = await characters.findByName(fresh.nickname);
    return row !== undefined && row.lastSeen.getTime() > registered.lastSeen.getTime() ? row : undefined;
  });
  const character = { ...left, ...changes, lastSeen: new Date(left.lastSeen.getTime() + 1) };
  expect(await characters.persistCheckpoint(character, inventory)).toBe(true);
  return character;
}

it('what a dreamer has grown into joins as it was stored, and a checkpoint stores what changed and nothing else', async () => {
  const lucidity: Lucidity = {
    role: 'heiler',
    ranks: [
      { teachingId: 'depth', rank: 1, practice: 3 },
      { teachingId: 'touch', rank: 2, practice: 12.5 },
    ],
    study: 'depth',
    task: { role: 'heiler', teachingId: 'drawing-back', progress: 22.5 },
  };
  const energy = { healthCurrent: 40, healthMax: 100, balanceCurrent: 60, balanceMax: 100, spiritCurrent: 30, spiritMax: 100 };
  const inventory: InventoryRow[] = [
    { slot: 0, itemId: 'purse', quantity: 137, equippedHand: undefined },
    { slot: 2, itemId: 'mondstein', quantity: 1, equippedHand: 'right' },
  ];
  const stored = await seeded('lucid', { lucidity, energy }, inventory);

  const joined = await loginOverWire(server.url, stored.name);
  const sent = (tag: string) => joined.join.find((message) => message.tag === tag)?.payload;
  expect(sent('energy')).toEqual(energy);
  expect(sent('lucidity')).toEqual(lucidity);
  expect(sent('inventory')).toEqual({
    rows: [
      { slot: 0, itemId: 'purse', quantity: 137 },
      { slot: 2, itemId: 'mondstein', quantity: 1, equippedHand: 'right' },
    ],
  });

  joined.client.send(frame({ tag: 'abandonTask', payload: {} }));
  const withoutTask = { role: lucidity.role, ranks: lucidity.ranks, study: lucidity.study };
  expect(await drainFrames(joined.client)).toEqual([{ tag: 'lucidity', payload: withoutTask }]);
  await closeAndAwaitCleanup(joined, server);
  const after = await pollUntil(async () => {
    const row = await characters.findByName(stored.name);
    return row !== undefined && row.lastSeen.getTime() > stored.lastSeen.getTime() ? row : undefined;
  });
  expect(after).toMatchObject({ lucidity: { ...lucidity, task: undefined }, energy });
  expect(await new PostgresInventoryRepository(harness.db).loadAll(stored.id)).toEqual(inventory);
});

it('a dreamer who left fallen joins fallen, and cannot move', async () => {
  const energy = { healthCurrent: 0, healthMax: 100, balanceCurrent: 80, balanceMax: 100, spiritCurrent: 100, spiritMax: 100 };
  const stored = await seeded('fallen', { energy }, []);
  const joined = await loginOverWire(server.url, stored.name);
  const self = joined.join.find((message) => message.tag === 'entity' && message.payload.id === joined.entityId);
  expect(self).toMatchObject({ payload: { condition: 'fallen', x: stored.position.x, z: stored.position.z } });
  joined.client.send(frame({ tag: 'move', payload: { x: stored.position.x + 0.1, z: stored.position.z, facing: 0, gait: 'walk' } }));
  expect(await drainFrames(joined.client)).toEqual([{ tag: 'correction', payload: stored.position }]);
  await joined.client.close();
  await pollUntil(() => Promise.resolve(server.server.worldRouter.loggedInPlayerCount() === 0 ? true : undefined));
});
