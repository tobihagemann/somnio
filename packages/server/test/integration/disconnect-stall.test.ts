import { afterAll, beforeAll, expect, it } from 'vitest';
import { bootTestServer, frame, holdLock, joinFreshPlayer, loginOverWire, pollUntil, startDatabase } from './support/harness.ts';
import type { DatabaseHarness, TestServer } from './support/harness.ts';

let harness: DatabaseHarness;
let server: TestServer;

beforeAll(async () => {
  harness = await startDatabase();
  server = await bootTestServer(harness.url, { databaseTimeouts: { statementMs: 300 } });
});
afterAll(async () => {
  await server.stop();
  await harness.stop();
});

it('lets a dreamer back in while the save of their disconnect is stuck behind a lock, once the pool gives up on it', async () => {
  const first = await joinFreshPlayer(server.url, 'stalled');
  const inventory = first.join.find((message) => message.tag === 'inventory');
  if (inventory?.tag !== 'inventory') throw new Error('join carried no inventory');
  const cudgel = inventory.payload.equipped[0]!.item;
  const release = await holdLock(harness.connect(), (transaction) =>
    transaction.selectFrom('characters').select('id').where('id', '=', first.entityId).forUpdate().execute(),
  );
  try {
    const before = server.server.worldRouter.loggedInPlayerCount();
    first.client.send(frame({ tag: 'dropItem', payload: { itemId: cudgel.id, heading: 0 } }));
    await first.client.close();
    await pollUntil(() => Promise.resolve(server.server.worldRouter.loggedInPlayerCount() < before ? true : undefined), 2000);
    const again = await loginOverWire(server.url, first.name);
    expect(again.entityId).toBe(first.entityId);
    await again.client.close();
  } finally {
    await release();
  }
  const failures = server.logging.stdoutRecords
    .map((chunk) => JSON.parse(chunk) as Record<string, unknown>)
    .filter((record) => record['msg'] === 'failed to persist player snapshot');
  expect(failures).toContainEqual(expect.objectContaining({ origin: 'disconnect', character_id: first.entityId }));
});
