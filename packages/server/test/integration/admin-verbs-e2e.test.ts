import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeAdminResponse, encodeAdminRequest } from '@somnio/protocol';
import type { AdminRequest, AdminResponse } from '@somnio/protocol';
import { PostgresWorldClockRepository } from '@somnio/data';
import { CLOSE_GOING_AWAY } from '../../src/connection/connectionActor.ts';
import { TestClient, bearer } from '../support/liveServer.ts';
import { TEST_ADMIN_TOKEN, TEST_SERVER_VERSION, bootTestServer, joinFreshPlayer, pollUntil, startDatabase, uniqueNickname } from './support/harness.ts';
import type { DatabaseHarness, TestServer } from './support/harness.ts';

let harness: DatabaseHarness;
let server: TestServer;

beforeAll(async () => {
  harness = await startDatabase();
  await new PostgresWorldClockRepository(harness.db).save({
    second: 50,
    minute: 11,
    hour: 7,
    day: 1,
    month: 1,
    year: 500,
  });
  // A one-minute tick keeps the seeded readout stable for the formatting case.
  server = await bootTestServer(harness.url, { worldClockIntervalMs: 60_000 });
});
afterAll(async () => {
  await server.stop();
  await harness.stop();
});

async function admin(): Promise<TestClient> {
  return TestClient.open(server.adminUrl, bearer(TEST_ADMIN_TOKEN));
}

async function ask(client: TestClient, request: AdminRequest): Promise<AdminResponse> {
  client.send(encodeAdminRequest(request));
  return decodeAdminResponse(await client.nextText());
}

describe('admin verbs end to end', () => {
  it('players returns the logged-in count from the live router', async () => {
    const alice = await joinFreshPlayer(server.url, 'alice');
    const bob = await joinFreshPlayer(server.url, 'bob');
    const client = await admin();
    expect(await ask(client, { tag: 'players' })).toEqual({ tag: 'playerCount', payload: '2' });
    await client.close();
    await alice.client.close();
    await bob.client.close();
    await pollUntil(() => Promise.resolve(server.server.worldRouter.loggedInPlayerCount() === 0 ? true : undefined));
  });

  it('time returns the live world clock formatted Y;M;D;HH;MM;SS', async () => {
    const client = await admin();
    expect(await ask(client, { tag: 'time' })).toEqual({ tag: 'worldClock', payload: '500;1;1;07;11;50' });
    await client.close();
  });

  it('time reflects a ticking world clock under a fast interval', async () => {
    const local = await startDatabase();
    await new PostgresWorldClockRepository(local.db).save({
      second: 50,
      minute: 11,
      hour: 7,
      day: 1,
      month: 1,
      year: 500,
    });
    const fast = await bootTestServer(local.url, { worldClockIntervalMs: 5 });
    try {
      const client = await TestClient.open(fast.adminUrl, bearer(TEST_ADMIN_TOKEN));
      const advanced = await pollUntil(async () => {
        const response = await ask(client, { tag: 'time' });
        return response.tag === 'worldClock' && response.payload !== '500;1;1;07;11;50' ? response.payload : undefined;
      });
      expect(advanced.startsWith('500;1;1;07;')).toBe(true);
      await client.close();
    } finally {
      await fast.stop();
      await local.stop();
    }
  });

  it('say broadcasts adminSay to every logged-in gameplay client and not to a pre-login socket', async () => {
    const alice = await joinFreshPlayer(server.url, 'alice');
    const bob = await joinFreshPlayer(server.url, 'bob');
    const stranger = await TestClient.open(server.url);
    await stranger.next();
    const client = await admin();
    expect(await ask(client, { tag: 'say', payload: 'hello world' })).toEqual({
      tag: 'sayBroadcast',
      payload: 'hello world',
    });
    expect((await alice.client.until('adminSay')).target).toEqual({
      tag: 'adminSay',
      payload: { text: 'hello world' },
    });
    expect((await bob.client.until('adminSay')).target).toEqual({
      tag: 'adminSay',
      payload: { text: 'hello world' },
    });
    await expect(stranger.nextText(300)).rejects.toThrow();
    await client.close();
    await stranger.close();
    await alice.client.close();
    await bob.client.close();
    await pollUntil(() => Promise.resolve(server.server.worldRouter.loggedInPlayerCount() === 0 ? true : undefined));
  });

  it('kick disconnects a named player and broadcasts leave', async () => {
    const alice = await joinFreshPlayer(server.url, 'alice');
    const bob = await joinFreshPlayer(server.url, 'bob');
    const client = await admin();
    expect(await ask(client, { tag: 'kick', payload: alice.nickname })).toEqual({
      tag: 'kickedPlayer',
      payload: alice.nickname,
    });
    expect((await bob.client.until('leave')).target).toEqual({
      tag: 'leave',
      payload: { entityIndex: alice.entityIndex, leftGame: true },
    });
    expect((await alice.client.closed).code).toBe(CLOSE_GOING_AWAY);
    const count = await pollUntil(async () => {
      const response = await ask(client, { tag: 'players' });
      return response.tag === 'playerCount' && response.payload === '1' ? response.payload : undefined;
    });
    expect(count).toBe('1');
    await client.close();
    await bob.client.close();
    await pollUntil(() => Promise.resolve(server.server.worldRouter.loggedInPlayerCount() === 0 ? true : undefined));
  });

  it('kick reports not-found for a name with no logged-in player', async () => {
    const client = await admin();
    const absent = uniqueNickname('absent');
    expect(await ask(client, { tag: 'kick', payload: absent })).toEqual({
      tag: 'kickedPlayerNotFound',
      payload: absent,
    });
    await client.close();
  });

  it('version returns the configured server version', async () => {
    const client = await admin();
    expect(await ask(client, { tag: 'version' })).toEqual({
      tag: 'versionString',
      payload: TEST_SERVER_VERSION,
    });
    await client.close();
  });

  it('an unknown verb answers unknownCommand and leaves the session open', async () => {
    const client = await admin();
    client.send('{"tag":"bogusVerb","payload":"x"}');
    expect(decodeAdminResponse(await client.nextText())).toEqual({ tag: 'unknownCommand' });
    expect(await ask(client, { tag: 'players' })).toEqual({ tag: 'playerCount', payload: '0' });
    await client.close();
  });
});
