import { afterAll, beforeAll, expect, it } from 'vitest';
import { PostgresCharacterRepository } from '@somnio/data';
import { bootTestServer, closeAndAwaitCleanup, joinFreshPlayer, loginOverWire, pollUntil, startDatabase } from './support/harness.ts';
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

function energyOf(joined: JoinedClient) {
  const energy = joined.join.find((message) => message.tag === 'energy');
  if (energy?.tag !== 'energy') throw new Error('join carried no energy');
  return energy.payload;
}

it('baseline energy pairs are persisted by the close checkpoint and surface on reconnect', async () => {
  const characters = new PostgresCharacterRepository(harness.db);
  const first = await joinFreshPlayer(server.url, 'energy');
  const baseline = energyOf(first);
  const registeredLastSeen = (await characters.findByName(first.nickname))!.lastSeen;
  await closeAndAwaitCleanup(first, server);
  // The strict advance is what proves the close checkpoint ran; the energy values match regardless.
  const persisted = await pollUntil(async () => {
    const row = await characters.findByName(first.nickname);
    return row !== undefined && row.lastSeen.getTime() > registeredLastSeen.getTime() ? row : undefined;
  });
  expect(persisted.energy).toEqual(baseline);
  const second = await loginOverWire(server.url, first.nickname);
  expect(energyOf(second)).toEqual(baseline);
  await second.client.close();
});
