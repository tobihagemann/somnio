import { describe, expect, it } from 'vitest';
import { encodeSomnioMessage } from '@somnio/protocol';
import type { RunningServer } from '../../src/http/server.ts';
import { FAILED_LOGIN_FRAME, TestClient, failedLogin, forwardedFor, gameplayURL, withLiveServer } from '../support/liveServer.ts';
import type { LiveServerOptions } from '../support/liveServer.ts';
import { enabledAttemptLimiter, makeStubConnectionDependencies } from '../support/stubDependencies.ts';

async function withLimitedServer<T>(options: Pick<LiveServerOptions, 'trustProxy'>, body: (server: RunningServer) => Promise<T>): Promise<T> {
  return withLiveServer({ ...options, dependencies: await makeStubConnectionDependencies({ attemptLimiter: enabledAttemptLimiter() }) }, body);
}

function failedLoginFrom(server: RunningServer, addresses: string) {
  return failedLogin(gameplayURL(server), forwardedFor(addresses));
}

describe('the pre-login limit over a live socket', () => {
  it('counts each client against the last forwarded address behind a trusted proxy', async () => {
    await withLimitedServer({ trustProxy: true }, async (server) => {
      for (let attempt = 0; attempt < 10; attempt += 1) expect(await failedLoginFrom(server, '203.0.113.7')).toBe('badCredentials');
      expect(await failedLoginFrom(server, '203.0.113.7')).toBe('throttled');
      expect(await failedLoginFrom(server, '203.0.113.8')).toBe('badCredentials');
      // Only reading the last entry throttles this one: its first entry still has a budget.
      expect(await failedLoginFrom(server, '203.0.113.8, 203.0.113.7')).toBe('throttled');
    });
  });

  it('keeps a throttled socket open and answers its next frame', async () => {
    await withLimitedServer({ trustProxy: true }, async (server) => {
      for (let attempt = 0; attempt < 10; attempt += 1) await failedLoginFrom(server, '203.0.113.7');
      const client = await TestClient.open(gameplayURL(server), forwardedFor('203.0.113.7'));
      client.send(FAILED_LOGIN_FRAME);
      expect((await client.until('loginResult')).target).toEqual({ tag: 'loginResult', payload: { result: 'throttled' } });
      client.send(encodeSomnioMessage({ tag: 'redeemSession', payload: { token: 'no-such-token' } }));
      expect(await client.next()).toEqual({ tag: 'loginResult', payload: { result: 'badCredentials' } });
      await client.close();
    });
  });

  /** Without a trusted proxy the header is the client's to write, so honouring it would hand out a budget per request. */
  it('counts every client against the socket address without a trusted proxy', async () => {
    await withLimitedServer({ trustProxy: false }, async (server) => {
      for (let attempt = 0; attempt < 10; attempt += 1) expect(await failedLoginFrom(server, `198.51.100.${attempt}`)).toBe('badCredentials');
      expect(await failedLoginFrom(server, '198.51.100.10')).toBe('throttled');
    });
  });
});
