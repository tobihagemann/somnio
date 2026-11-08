import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { encodeSomnioMessage } from '@somnio/protocol';
import type { Character } from '@somnio/core';
import { newCharacter } from '@somnio/data';
import { WebSocket } from 'ws';
import { CARD_TIMED_OUT, CLOSE_POLICY_VIOLATION, LOGIN_TIMED_OUT } from '../../src/connection/connectionActor.ts';
import type { RunningServer } from '../../src/http/server.ts';
import { redeemToCard, sendRedeem } from '../support/characterCard.ts';
import { SocketAdmission } from '../../src/connection/socketAdmission.ts';
import { FAILED_LOGIN_FRAME, TestClient, attemptUpgrade, gameplayURL, withLiveServer } from '../support/liveServer.ts';
import { testLogger } from '../support/logger.ts';
import { makeStubConnectionDependencies } from '../support/stubDependencies.ts';
import { HeldSessionRepository, StubCharacterRepository, StubSessionRepository } from '../support/stubRepositories.ts';

const DEADLINE_MS = 200;
const TIMED_OUT = { code: CLOSE_POLICY_VIOLATION, reason: LOGIN_TIMED_OUT };

describe('the login deadline', () => {
  it('closes a socket that sends nothing', async () => {
    const dependencies = await makeStubConnectionDependencies({ loginDeadlineMs: DEADLINE_MS });
    await withLiveServer({ dependencies }, async (server) => {
      const client = await TestClient.open(gameplayURL(server));
      expect(await client.closed).toEqual(TIMED_OUT);
    });
  });

  /**
   * A redeemed session rather than a password login, so no Argon2 verify races the deadline. The
   * account has no character, so the socket stays choosing one: the login deadline ends at the login.
   */
  it('leaves a socket that logged in within it open while it chooses a character', async () => {
    const sessions = new StubSessionRepository();
    const issued = await sessions.issue(crypto.randomUUID(), 3600);
    const dependencies = await makeStubConnectionDependencies({ sessions, loginDeadlineMs: DEADLINE_MS });
    await withLiveServer({ dependencies }, async (server) => {
      const client = await TestClient.open(gameplayURL(server));
      expect((await redeemToCard(client, issued.token)).characters).toEqual([]);
      await delay(2 * DEADLINE_MS);
      expect(client.socket.readyState).toBe(WebSocket.OPEN);
      await client.close();
    });
  });

  it('closes a socket that keeps failing to log in all the same', async () => {
    const dependencies = await makeStubConnectionDependencies({ loginDeadlineMs: DEADLINE_MS });
    await withLiveServer({ dependencies }, async (server) => {
      const client = await TestClient.open(gameplayURL(server));
      const sender = setInterval(() => client.send(FAILED_LOGIN_FRAME), 20);
      try {
        expect(await client.closed).toEqual(TIMED_OUT);
      } finally {
        clearInterval(sender);
      }
    });
  });

  it('closes a socket whose handler is still running, and keeps its slot until the handler ends', async () => {
    const sessions = new HeldSessionRepository();
    const dependencies = await makeStubConnectionDependencies({ sessions, loginDeadlineMs: DEADLINE_MS });
    const socketAdmission = new SocketAdmission({
      perAddressEnabled: true,
      perAddress: 1,
      total: 8,
      authenticatedPerAddress: 8,
      authenticated: 8,
      logger: testLogger(),
    });
    await withLiveServer({ dependencies, socketAdmission }, async (server) => {
      const held = await TestClient.open(gameplayURL(server));
      sendRedeem(held, 'held');
      await sessions.reached;
      expect(await held.closed).toEqual(TIMED_OUT);
      const whileHeld = await attemptUpgrade(gameplayURL(server));
      // Released before the assertion: a held handler would otherwise keep the teardown waiting.
      sessions.releaseHandler();
      expect(whileHeld).toBe(429);
      // The server frees a slot after the exit path, which can trail the client's own close.
      await vi.waitFor(async () => expect(await attemptUpgrade(gameplayURL(server))).toBe('opened'), { timeout: 2000 });
    });
  });
});

const CARD_TIMED = { code: CLOSE_POLICY_VIOLATION, reason: CARD_TIMED_OUT };

/** On the card of an account with no character, through a redeemed session, so no Argon2 verify races the deadline. */
async function onCard(server: RunningServer, token: string): Promise<TestClient> {
  const client = await TestClient.open(gameplayURL(server));
  await redeemToCard(client, token);
  return client;
}

describe('the character card deadline', () => {
  it('closes a socket on the card that asks nothing, and its account can log in again', async () => {
    const sessions = new StubSessionRepository();
    const issued = await sessions.issue(crypto.randomUUID(), 3600);
    const dependencies = await makeStubConnectionDependencies({ sessions, cardDeadlineMs: DEADLINE_MS });
    await withLiveServer({ dependencies }, async (server) => {
      const idle = await onCard(server, issued.token);
      expect(await idle.closed).toEqual(CARD_TIMED);
      // The account is released by the exit path, which can trail the client's own close.
      const again = await vi.waitFor(() => onCard(server, issued.token), { timeout: 2000 });
      await again.close();
    });
  });

  it('starts again at each request on the card', async () => {
    const sessions = new StubSessionRepository();
    const issued = await sessions.issue(crypto.randomUUID(), 3600);
    const dependencies = await makeStubConnectionDependencies({ sessions, cardDeadlineMs: DEADLINE_MS });
    await withLiveServer({ dependencies }, async (server) => {
      const client = await onCard(server, issued.token);
      const asker = setInterval(
        () => client.send(encodeSomnioMessage({ tag: 'deleteCharacter', payload: { characterId: crypto.randomUUID() } })),
        DEADLINE_MS / 4,
      );
      try {
        await delay(3 * DEADLINE_MS);
        expect(client.socket.readyState).toBe(WebSocket.OPEN);
      } finally {
        clearInterval(asker);
      }
      expect(await client.closed).toEqual(CARD_TIMED);
    });
  });
});

/** A join that left the card's deadline running would close every player that long into play. */
describe('joining the world', () => {
  async function staysInWorld(character: Character, join: (client: TestClient, token: string) => Promise<void>): Promise<void> {
    const sessions = new StubSessionRepository();
    const accountId = crypto.randomUUID();
    const issued = await sessions.issue(accountId, 3600);
    const characters = new StubCharacterRepository(new Map([[accountId, [character]]]));
    const dependencies = await makeStubConnectionDependencies({ sessions, characters, cardDeadlineMs: DEADLINE_MS });
    await withLiveServer({ dependencies }, async (server) => {
      const client = await TestClient.open(gameplayURL(server));
      await join(client, issued.token);
      await client.until('enterSpace');
      await delay(3 * DEADLINE_MS);
      expect(client.socket.readyState).toBe(WebSocket.OPEN);
      await client.close();
    });
  }

  it('ends the card deadline for a redeem that joins the character played last', async () => {
    const played = { ...newCharacter(crypto.randomUUID(), 'Ida', 'vigils'), lastSeen: new Date() };
    await staysInWorld(played, (client, token) => {
      sendRedeem(client, token);
      return Promise.resolve();
    });
  });

  it('ends the card deadline for a character chosen on the card', async () => {
    const unplayed = newCharacter(crypto.randomUUID(), 'Ida', 'vigils');
    await staysInWorld(unplayed, async (client, token) => {
      await redeemToCard(client, token);
      client.send(encodeSomnioMessage({ tag: 'selectCharacter', payload: { characterId: unplayed.id } }));
    });
  });
});
