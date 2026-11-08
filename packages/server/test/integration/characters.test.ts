import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import type { SomnioMessage } from '@somnio/protocol';
import { DEFAULT_AUTHENTICATED_SOCKETS } from '../../src/config.ts';
import { CLOSE_TRY_AGAIN_LATER, TOO_MANY_CHOOSING } from '../../src/connection/connectionActor.ts';
import { askOnCard, loginToCard, redeemToCard, sendRedeem } from '../support/characterCard.ts';
import type { OnCard } from '../support/characterCard.ts';
import { TestClient } from '../support/liveServer.ts';
import {
  TEST_PASSWORD,
  accountsWithSessions,
  bootTestServer,
  drainFrames,
  frame,
  pollUntil,
  emailFor,
  registerFrame,
  sleep,
  startDatabase,
  uniqueName,
} from './support/harness.ts';
import type { DatabaseHarness, TestServer } from './support/harness.ts';

let harness: DatabaseHarness;
let server: TestServer;

beforeAll(async () => {
  harness = await startDatabase();
  server = await bootTestServer(harness.url);
});
// A closed socket's server-side cleanup outlives the client's close event; waiting for it keeps one
// test's players out of the next.
afterEach(async () => {
  await pollUntil(() => Promise.resolve(server.server.worldRouter.loggedInPlayerCount() === 0 ? true : undefined));
});
afterAll(async () => {
  await server.stop();
  await harness.stop();
});

type ClientOnCard = OnCard & { client: TestClient };

async function register(email: string): Promise<void> {
  const client = await TestClient.open(server.url);
  await client.next();
  client.send(registerFrame(email));
  expect((await client.until('registerResult')).target).toEqual({ tag: 'registerResult', payload: { result: 'ok' } });
  await client.close();
}

async function login(email: string, requestSessionToken = false): Promise<ClientOnCard> {
  const client = await TestClient.open(server.url);
  await client.next();
  return { client, ...(await loginToCard(client, { email, password: TEST_PASSWORD, ...(requestSessionToken ? { requestSessionToken } : {}) })) };
}

async function registerAndLogin(prefix: string, requestSessionToken = false): Promise<ClientOnCard & { email: string }> {
  const email = emailFor(uniqueName(prefix));
  await register(email);
  return { email, ...(await login(email, requestSessionToken)) };
}

async function ask(client: TestClient, message: SomnioMessage) {
  const { result, characters } = await askOnCard(client, message);
  return { result, characters };
}

function create(client: TestClient, name: string, people = 'vigils') {
  return ask(client, { tag: 'createCharacter', payload: { name, people } });
}

/** Selects a character and answers its `enterSpace`, or the failure that refused it. */
async function select(client: TestClient, characterId: string): Promise<SomnioMessage> {
  client.send(frame({ tag: 'selectCharacter', payload: { characterId } }));
  for (;;) {
    const received = await client.next();
    if (received.tag === 'enterSpace' || received.tag === 'characterResult') return received;
  }
}

/** Redeems a token, retrying while the account's previous socket is still being cleaned up. */
async function redeem(token: string): Promise<TestClient> {
  for (;;) {
    const client = await TestClient.open(server.url);
    await client.next();
    sendRedeem(client, token);
    const answer = (await client.until('loginResult')).target;
    if (answer.tag === 'loginResult' && answer.payload.result === 'ok') return client;
    expect(answer).toEqual({ tag: 'loginResult', payload: { result: 'alreadyLoggedIn' } });
    await client.close();
    await sleep(50);
  }
}

function sessionTokenOf(card: ClientOnCard): string {
  const issued = card.frames.find((message) => message.tag === 'sessionToken');
  if (issued?.tag !== 'sessionToken') throw new Error('no session token issued');
  return issued.payload.token;
}

describe('the character card', () => {
  it('lists no character after registering, creates two, and joins as one', async () => {
    const card = await registerAndLogin('card');
    expect(card.characters).toEqual([]);

    const first = await create(card.client, uniqueName('ida'), 'umbrae');
    expect(first.result).toBe('ok');
    const second = await create(card.client, uniqueName('ada'), 'lumina');
    expect(second.result).toBe('ok');
    expect(second.characters).toHaveLength(2);
    expect(second.characters!.map((character) => character.people).sort()).toEqual(['lumina', 'umbrae']);
    expect(second.characters!.every((character) => character.role === undefined)).toBe(true);

    const chosen = second.characters![1]!;
    expect(await select(card.client, chosen.id)).toMatchObject({ tag: 'enterSpace', payload: { selfId: chosen.id } });
    await card.client.close();
  });

  it('refuses a character past the most an account holds with full', async () => {
    const card = await registerAndLogin('full');
    for (let index = 0; index < SOMNIO_PROTOCOL_CONSTANTS.maxCharactersPerAccount; index += 1) {
      expect((await create(card.client, uniqueName(`full${index}`))).result).toBe('ok');
    }
    expect(await create(card.client, uniqueName('fifth'))).toEqual({ result: 'full', characters: undefined });
    await card.client.close();
  });

  it("refuses a name another account's character holds with nameExists", async () => {
    const taken = uniqueName('taken');
    const owner = await registerAndLogin('owner');
    expect((await create(owner.client, taken)).result).toBe('ok');
    const other = await registerAndLogin('other');
    expect(await create(other.client, taken.toUpperCase())).toEqual({ result: 'nameExists', characters: undefined });
    await owner.client.close();
    await other.client.close();
  });

  it("deletes one of the account's characters, and refuses to delete or select another account's", async () => {
    const card = await registerAndLogin('deleter');
    const kept = (await create(card.client, uniqueName('kept'))).characters![0]!;
    const doomed = (await create(card.client, uniqueName('doomed'))).characters!.find((character) => character.id !== kept.id)!;
    expect(await ask(card.client, { tag: 'deleteCharacter', payload: { characterId: doomed.id } })).toEqual({ result: 'ok', characters: [kept] });

    const stranger = await registerAndLogin('stranger');
    const theirs = (await create(stranger.client, uniqueName('theirs'))).characters![0]!;
    expect(await ask(card.client, { tag: 'deleteCharacter', payload: { characterId: theirs.id } })).toEqual({ result: 'failure', characters: undefined });
    expect(await select(card.client, theirs.id)).toEqual({ tag: 'characterResult', payload: { result: 'failure' } });
    expect(await select(stranger.client, theirs.id)).toMatchObject({ tag: 'enterSpace', payload: { selfId: theirs.id } });
    await card.client.close();
    await stranger.client.close();
  });

  it('refuses a second browser logging into the account while the first is on the card, and admits it once the first has gone', async () => {
    const card = await registerAndLogin('single');
    const second = await TestClient.open(server.url);
    await second.next();
    second.send(frame({ tag: 'login', payload: { email: card.email, password: TEST_PASSWORD } }));
    expect((await second.until('loginResult')).target).toEqual({ tag: 'loginResult', payload: { result: 'alreadyLoggedIn' } });
    await second.close();

    await card.client.close();
    // Closing on the card writes nothing, but the release still trails the client's own close.
    const again = await pollUntil(async () => {
      const client = await TestClient.open(server.url);
      await client.next();
      client.send(frame({ tag: 'login', payload: { email: card.email, password: TEST_PASSWORD } }));
      const answer = (await client.until('loginResult')).target;
      if (answer.tag === 'loginResult' && answer.payload.result === 'ok') return client;
      await client.close();
      return undefined;
    });
    await again.close();
  });

  it('does not resume a character created but never played', async () => {
    const card = await registerAndLogin('unplayed', true);
    const created = (await create(card.client, uniqueName('unplayed'))).characters!;
    await card.client.close();

    const resumed = await redeem(sessionTokenOf(card));
    expect((await resumed.until('characters')).target).toEqual({ tag: 'characters', payload: { characters: created } });
    expect((await drainFrames(resumed)).map((message) => message.tag)).not.toContain('enterSpace');
    await resumed.close();
  });

  it('resumes a remembered session as the character played last', async () => {
    const card = await registerAndLogin('resumer', true);
    const listed = (await create(card.client, uniqueName('first'))).characters!;
    const first = listed[0]!;
    const last = (await create(card.client, uniqueName('last'))).characters!.find((character) => character.id !== first.id)!;
    expect(await select(card.client, first.id)).toMatchObject({ tag: 'enterSpace' });
    await card.client.close();
    await pollUntil(() => Promise.resolve(server.server.worldRouter.loggedInPlayerCount() === 0 ? true : undefined));

    const again = await login(card.email);
    expect(again.characters.map((character) => character.id)).toEqual([first.id, last.id]);
    expect(await select(again.client, last.id)).toMatchObject({ tag: 'enterSpace' });
    await again.client.close();
    await pollUntil(() => Promise.resolve(server.server.worldRouter.loggedInPlayerCount() === 0 ? true : undefined));

    const resumed = await redeem(sessionTokenOf(card));
    expect(await resumed.until('enterSpace')).toMatchObject({ target: { tag: 'enterSpace', payload: { selfId: last.id } } });
    await resumed.close();
  });

  /** The database's collation ignores the space and the case these names differ by; the card's order must not. */
  it('answers a create in the order a later login lists', async () => {
    const suffix = crypto.randomUUID().slice(0, 6);
    const card = await registerAndLogin('orderer');
    const played = (await create(card.client, `Played ${suffix}`)).characters![0]!;
    expect(await select(card.client, played.id)).toMatchObject({ tag: 'enterSpace' });
    await card.client.close();
    await pollUntil(() => Promise.resolve(server.server.worldRouter.loggedInPlayerCount() === 0 ? true : undefined));

    const again = await login(card.email);
    expect((await create(again.client, `Mary Jane ${suffix}`)).result).toBe('ok');
    expect((await create(again.client, `ida ${suffix}`)).result).toBe('ok');
    const created = (await create(again.client, `Maryann ${suffix}`)).characters!;
    expect(created.map((character) => character.name)).toEqual([`Played ${suffix}`, `Mary Jane ${suffix}`, `Maryann ${suffix}`, `ida ${suffix}`]);
    await again.client.close();
    await pollUntil(() => Promise.resolve(server.server.worldRouter.loggedInPlayerCount() === 0 ? true : undefined));

    const listed = await login(card.email);
    expect(listed.characters.map((character) => character.id)).toEqual(created.map((character) => character.id));
    await listed.client.close();
  });
});

/** Servers of their own, so no other test's sockets count against what these hold. */
describe('the card outside the login limits', () => {
  it('keeps a socket on the card past the login deadline, and it still creates and joins', async () => {
    const deadlineMs = 300;
    const local = await bootTestServer(harness.url, { loginDeadlineMs: deadlineMs });
    try {
      const [token] = await accountsWithSessions(local, 1);
      const card = await redeemOnCard(local, token!);
      await sleep(3 * deadlineMs);
      const created = await create(card.client, uniqueName('patient'));
      expect(created.result).toBe('ok');
      expect(await select(card.client, created.characters![0]!.id)).toMatchObject({ tag: 'enterSpace' });
      await card.client.close();
    } finally {
      await local.stop();
    }
  });

  it('closes an authentication past the sockets the server holds on the card with 1013', async () => {
    const local = await bootTestServer(harness.url);
    try {
      const tokens = await accountsWithSessions(local, DEFAULT_AUTHENTICATED_SOCKETS + 1);
      const choosing = await Promise.all(tokens.slice(0, DEFAULT_AUTHENTICATED_SOCKETS).map((token) => redeemOnCard(local, token)));
      const refused = await TestClient.open(local.url);
      sendRedeem(refused, tokens.at(-1)!);
      expect(await refused.closed).toEqual({ code: CLOSE_TRY_AGAIN_LATER, reason: TOO_MANY_CHOOSING });
      await Promise.all(choosing.map((card) => card.client.close()));
    } finally {
      await local.stop();
    }
  });

  async function redeemOnCard(local: TestServer, token: string): Promise<ClientOnCard> {
    const client = await TestClient.open(local.url);
    return { client, ...(await redeemToCard(client, token)) };
  }
});
