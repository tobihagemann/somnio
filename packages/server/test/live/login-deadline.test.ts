import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { encodeSomnioMessage } from '@somnio/protocol';
import { WebSocket } from 'ws';
import { CLOSE_POLICY_VIOLATION, LOGIN_TIMED_OUT } from '../../src/connection/connectionActor.ts';
import { SocketAdmission } from '../../src/connection/socketAdmission.ts';
import { FAILED_LOGIN_FRAME, TestClient, attemptUpgrade, gameplayURL, withLiveServer } from '../support/liveServer.ts';
import { testLogger } from '../support/logger.ts';
import { makeOneSectorWorld } from '../support/oneSectorWorld.ts';
import { makeStubConnectionDependencies } from '../support/stubDependencies.ts';
import { HeldSessionRepository, StubSessionRepository } from '../support/stubRepositories.ts';

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

  /** A redeemed session rather than a password login, so no Argon2 verify races the deadline. */
  it('leaves a socket that logged in within it open', async () => {
    const sessions = new StubSessionRepository();
    const world = await makeOneSectorWorld({ sessions });
    const issued = await sessions.issue(world.accountId, 3600);
    const dependencies = { ...world.dependencies, loginDeadlineMs: DEADLINE_MS };
    await withLiveServer({ dependencies }, async (server) => {
      const client = await TestClient.open(gameplayURL(server));
      client.send(encodeSomnioMessage({ tag: 'redeemSession', payload: { token: issued.token } }));
      expect((await client.until('loginResult')).target).toEqual({ tag: 'loginResult', payload: { result: 'ok' } });
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
    const socketAdmission = new SocketAdmission({ perAddressEnabled: true, perAddress: 1, total: 8, logger: testLogger() });
    await withLiveServer({ dependencies, socketAdmission }, async (server) => {
      const held = await TestClient.open(gameplayURL(server));
      held.send(encodeSomnioMessage({ tag: 'redeemSession', payload: { token: 'held' } }));
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
