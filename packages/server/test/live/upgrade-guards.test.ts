import { connect } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { encodeSomnioMessage } from '@somnio/protocol';
import { SocketAdmission } from '../../src/connection/socketAdmission.ts';
import type { RunningServer } from '../../src/http/server.ts';
import { TestClient, attemptUpgrade, forwardedFor, gameplayURL, withLiveServer } from '../support/liveServer.ts';
import { testLogger } from '../support/logger.ts';
import { makeOneSectorWorld } from '../support/oneSectorWorld.ts';
import { makeStubConnectionDependencies } from '../support/stubDependencies.ts';
import { HeldSessionRepository, StubSessionRepository } from '../support/stubRepositories.ts';

/** A raw upgrade request for an arbitrary target, including ones Node's parser accepts but `URL` refuses. */
function rawUpgrade(port: number, target: string, withKey = true): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    let response = '';
    socket.on('connect', () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
          `Sec-WebSocket-Version: 13\r\n${withKey ? 'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n' : ''}\r\n`,
      );
    });
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString('latin1');
    });
    socket.on('close', () => resolve(response));
    // A listener already closed refuses the connection outright: report it as an empty response.
    socket.on('error', () => resolve(response));
    // A 101 leaves the socket open; give up on it so a regression fails instead of hanging.
    setTimeout(() => socket.destroy(), 2000).unref();
  });
}

describe('upgrade guards', () => {
  it('a request target URL cannot parse answers 400 and leaves the server up', async () => {
    await withLiveServer({}, async (server) => {
      const response = await rawUpgrade(server.port, '//[/');
      expect(response.startsWith('HTTP/1.1 400 ')).toBe(true);
      expect(await attemptUpgrade(gameplayURL(server))).toBe('opened');
    });
  });

  it('an upgrade arriving while shutdown awaits a connection is refused with 503', async () => {
    const sessions = new HeldSessionRepository();
    const dependencies = await makeStubConnectionDependencies({ sessions });
    await withLiveServer({ dependencies }, async (server) => {
      // A connection stuck in a handler keeps `close()` awaiting its exit with the listener still
      // open: exactly the window a late upgrade lands in.
      const held = await TestClient.open(gameplayURL(server));
      await held.next();
      held.send(encodeSomnioMessage({ tag: 'redeemSession', payload: { token: 'held' } }));
      await sessions.reached;
      const closing = server.close();
      const response = await rawUpgrade(server.port, '/ws');
      // Released before the assertion: a held handler would otherwise keep the teardown waiting.
      sessions.releaseHandler();
      expect(response.startsWith('HTTP/1.1 503 ')).toBe(true);
      await closing;
      await held.closed;
    });
  });
});

describe('the cap on sockets awaiting login', () => {
  function admission(perAddressEnabled: boolean, perAddress = 2, total = 3): SocketAdmission {
    return new SocketAdmission({ perAddressEnabled, perAddress, total, logger: testLogger() });
  }

  function openFrom(server: RunningServer, address: string): Promise<TestClient> {
    return TestClient.open(gameplayURL(server), forwardedFor(address));
  }

  it('answers 429 for an address holding its share and 503 once the server holds its total', async () => {
    await withLiveServer({ trustProxy: true, socketAdmission: admission(true) }, async (server) => {
      const held = [await openFrom(server, '203.0.113.7'), await openFrom(server, '203.0.113.7')];
      expect(await attemptUpgrade(gameplayURL(server), forwardedFor('203.0.113.7'))).toBe(429);
      held.push(await openFrom(server, '203.0.113.8'));
      expect(await attemptUpgrade(gameplayURL(server), forwardedFor('203.0.113.9'))).toBe(503);
      await Promise.all(held.map((client) => client.close()));
    });
  });

  it('frees a slot when its socket closes', async () => {
    await withLiveServer({ trustProxy: true, socketAdmission: admission(true) }, async (server) => {
      const first = await openFrom(server, '203.0.113.7');
      const second = await openFrom(server, '203.0.113.7');
      await first.close();
      // The server frees a slot after the exit path, which can trail the client's own close.
      await vi.waitFor(async () => expect(await attemptUpgrade(gameplayURL(server), forwardedFor('203.0.113.7'))).toBe('opened'), { timeout: 2000 });
      await second.close();
    });
  });

  it('stops counting a socket once its player is in the world', async () => {
    const sessions = new StubSessionRepository();
    const world = await makeOneSectorWorld({ sessions });
    const issued = await sessions.issue(world.accountId, 3600);
    await withLiveServer({ dependencies: world.dependencies, socketAdmission: admission(true, 1, 1) }, async (server) => {
      const player = await TestClient.open(gameplayURL(server));
      player.send(encodeSomnioMessage({ tag: 'redeemSession', payload: { token: issued.token } }));
      expect((await player.until('loginResult')).target).toEqual({ tag: 'loginResult', payload: { result: 'ok' } });
      expect(await attemptUpgrade(gameplayURL(server))).toBe('opened');
      await player.close();
    });
  });

  it('caps the total with per-address counting off', async () => {
    await withLiveServer({ socketAdmission: admission(false) }, async (server) => {
      const held = [await TestClient.open(gameplayURL(server)), await TestClient.open(gameplayURL(server)), await TestClient.open(gameplayURL(server))];
      expect(await attemptUpgrade(gameplayURL(server))).toBe(503);
      await Promise.all(held.map((client) => client.close()));
    });
  });

  /** `ws` aborts such a handshake without calling back, so the slot is freed with the raw socket. */
  it('frees the slot of a handshake ws refuses', async () => {
    await withLiveServer({ socketAdmission: admission(false, 1, 1) }, async (server) => {
      const response = await rawUpgrade(server.port, '/ws', false);
      expect(response.startsWith('HTTP/1.1 400 ')).toBe(true);
      await vi.waitFor(async () => expect(await attemptUpgrade(gameplayURL(server))).toBe('opened'), { timeout: 2000 });
    });
  });
});
