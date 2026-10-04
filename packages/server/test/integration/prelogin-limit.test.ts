import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { LoginResult } from '@somnio/protocol';
import { failedLogin, forwardedFor } from '../support/liveServer.ts';
import { bootTestServer, startDatabase } from './support/harness.ts';
import type { DatabaseHarness, TestServer } from './support/harness.ts';

const PRELOGIN_LABEL = 'de.tobiha.somnio.server.gameplay.prelogin';
const ERROR_LEVEL = 50;

let harness: DatabaseHarness;
let server: TestServer | undefined;

beforeAll(async () => {
  harness = await startDatabase();
});
afterEach(async () => {
  await server?.stop();
  server = undefined;
});
afterAll(async () => {
  await harness.stop();
});

async function boot(env: Record<string, string>): Promise<TestServer> {
  server = await bootTestServer(harness.url, { env });
  return server;
}

function stdoutRecords(booted: TestServer): Record<string, unknown>[] {
  return booted.logging.stdoutRecords.map((chunk) => JSON.parse(chunk) as Record<string, unknown>);
}

function readyRecord(booted: TestServer): Record<string, unknown> | undefined {
  return stdoutRecords(booted).find((record) => record['msg'] === 'SomnioServer ready');
}

/** The error records that name the setting, whichever logger wrote them. */
function settingErrors(booted: TestServer): Record<string, unknown>[] {
  return stdoutRecords(booted).filter((record) => record['level'] === ERROR_LEVEL && String(record['msg']).includes('SOMNIO_TRUST_PROXY'));
}

async function failedLogins(booted: TestServer, forwarded: (attempt: number) => string | undefined): Promise<LoginResult[]> {
  const results: LoginResult[] = [];
  for (let attempt = 0; attempt < 11; attempt += 1) {
    const addresses = forwarded(attempt);
    results.push(await failedLogin(booted.url, addresses === undefined ? {} : forwardedFor(addresses)));
  }
  return results;
}

const TEN_REJECTED = Array<LoginResult>(10).fill('badCredentials');

describe('the pre-login limit through the production boot', () => {
  /** Only a boot that both enables the limiter and hands header trust to the HTTP server produces this pair. */
  it('SOMNIO_TRUST_PROXY=1 limits each forwarded address on its own', async () => {
    const booted = await boot({ SOMNIO_TRUST_PROXY: '1' });
    expect(readyRecord(booted)).toMatchObject({ prelogin_limit: 'proxy' });
    expect(await failedLogins(booted, () => '203.0.113.7')).toEqual([...TEN_REJECTED, 'throttled']);
    expect(await failedLogin(booted.url, forwardedFor('203.0.113.8'))).toBe('badCredentials');
    expect(settingErrors(booted)).toEqual([]);
  });

  it('SOMNIO_TRUST_PROXY=0 limits the socket address and ignores the header', async () => {
    const booted = await boot({ SOMNIO_TRUST_PROXY: '0' });
    expect(readyRecord(booted)).toMatchObject({ prelogin_limit: 'direct' });
    expect(await failedLogins(booted, (attempt) => `198.51.100.${attempt}`)).toEqual([...TEN_REJECTED, 'throttled']);
  });

  /** Behind a proxy every client would share its address, so an unstated setting limits nobody and says so. */
  it('an unset SOMNIO_TRUST_PROXY boots with the limit off and one error record in the gameplay log', async () => {
    const booted = await boot({});
    expect(readyRecord(booted)).toMatchObject({ prelogin_limit: 'off' });
    expect(settingErrors(booted)).toMatchObject([{ label: PRELOGIN_LABEL }]);
    expect(await failedLogins(booted, () => undefined)).toEqual([...TEN_REJECTED, 'badCredentials']);
  });

  it('SOMNIO_DEV_DEFAULTS=1 leaves the limit off without the error record', async () => {
    const booted = await boot({ SOMNIO_DEV_DEFAULTS: '1' });
    expect(readyRecord(booted)).toMatchObject({ prelogin_limit: 'off' });
    expect(settingErrors(booted)).toEqual([]);
  });
});
