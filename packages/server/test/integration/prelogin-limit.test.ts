import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { LoginResult } from '@somnio/protocol';
import { PostgresAccountRepository } from '@somnio/data';
import { TestClient, attemptUpgrade, failedLogin, forwardedFor } from '../support/liveServer.ts';
import { bootTestServer, registerFrame, startDatabase } from './support/harness.ts';
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

/** Eleven failed logins. A nickname per attempt unless one is named, so only the address budget can throttle. */
async function failedLogins(
  booted: TestServer,
  forwarded: (attempt: number) => string | undefined,
  nickname?: (attempt: number) => string,
): Promise<LoginResult[]> {
  const results: LoginResult[] = [];
  for (let attempt = 0; attempt < 11; attempt += 1) {
    const addresses = forwarded(attempt);
    results.push(await failedLogin(booted.url, addresses === undefined ? {} : forwardedFor(addresses), nickname?.(attempt) ?? `nobody-${attempt}`));
  }
  return results;
}

async function wrongBearers(booted: TestServer, count: number): Promise<('opened' | number)[]> {
  const outcomes: ('opened' | number)[] = [];
  for (let attempt = 0; attempt < count; attempt += 1) {
    outcomes.push(await attemptUpgrade(booted.adminUrl, { headers: { authorization: 'Bearer wrong', 'x-forwarded-for': '203.0.113.7' } }));
  }
  return outcomes;
}

/** Opens sockets from one forwarded address that never log in, then reports how the next upgrade from it fares. */
async function upgradeAfterIdleSockets(booted: TestServer, count: number): Promise<'opened' | number> {
  const idle: TestClient[] = [];
  for (let socket = 0; socket < count; socket += 1) idle.push(await TestClient.open(booted.url, forwardedFor('203.0.113.7')));
  const outcome = await attemptUpgrade(booted.url, forwardedFor('203.0.113.7'));
  await Promise.all(idle.map((client) => client.close()));
  return outcome;
}

const TEN_REJECTED = Array<LoginResult>(10).fill('badCredentials');

describe('the pre-login limit through the production boot', () => {
  /** Only a boot that both enables the limiter and hands header trust to the HTTP server produces this pair. */
  it('SOMNIO_TRUST_PROXY=1 limits each forwarded address on its own', async () => {
    const booted = await boot({ SOMNIO_TRUST_PROXY: '1' });
    expect(readyRecord(booted)).toMatchObject({ prelogin_limit: 'proxy' });
    expect(await failedLogins(booted, () => '203.0.113.7')).toEqual([...TEN_REJECTED, 'throttled']);
    expect(await failedLogin(booted.url, forwardedFor('203.0.113.8'), 'nobody-11')).toBe('badCredentials');
    expect(settingErrors(booted)).toEqual([]);
  });

  it('SOMNIO_TRUST_PROXY=1 limits failed logins at one name across forwarded addresses', async () => {
    const booted = await boot({ SOMNIO_TRUST_PROXY: '1' });
    expect(
      await failedLogins(
        booted,
        (attempt) => `203.0.113.${attempt}`,
        () => 'nobody',
      ),
    ).toEqual([...TEN_REJECTED, 'throttled']);
    // A typed name that names no account may be a password in the wrong field, so no record carries it.
    expect(JSON.stringify(stdoutRecords(booted))).not.toContain('nobody');
  });

  it('SOMNIO_TRUST_PROXY=1 answers 429 past ten wrong /admin bearers from one forwarded address', async () => {
    const booted = await boot({ SOMNIO_TRUST_PROXY: '1' });
    expect(await wrongBearers(booted, 11)).toEqual([...Array<number>(10).fill(401), 429]);
  });

  it('SOMNIO_TRUST_PROXY=1 answers 429 for a ninth socket awaiting login from one forwarded address', async () => {
    const booted = await boot({ SOMNIO_TRUST_PROXY: '1' });
    expect(await upgradeAfterIdleSockets(booted, 8)).toBe(429);
  });

  it('SOMNIO_TRUST_PROXY=0 limits the socket address and ignores the header', async () => {
    const booted = await boot({ SOMNIO_TRUST_PROXY: '0' });
    expect(readyRecord(booted)).toMatchObject({ prelogin_limit: 'direct' });
    expect(await failedLogins(booted, (attempt) => `198.51.100.${attempt}`)).toEqual([...TEN_REJECTED, 'throttled']);
  });

  /** Behind a proxy every client would share its address, so an unstated setting limits no address and says so. */
  it('an unset SOMNIO_TRUST_PROXY boots with the per-address limits off and one error record in the gameplay log', async () => {
    const booted = await boot({});
    expect(readyRecord(booted)).toMatchObject({ prelogin_limit: 'off' });
    expect(settingErrors(booted)).toMatchObject([{ label: PRELOGIN_LABEL, msg: expect.stringContaining('per-address') as unknown }]);
    expect(await failedLogins(booted, () => undefined)).toEqual([...TEN_REJECTED, 'badCredentials']);
    expect(await wrongBearers(booted, 11)).toEqual(Array<number>(11).fill(401));
    expect(await upgradeAfterIdleSockets(booted, 8)).toBe('opened');
  });

  it('an unset SOMNIO_TRUST_PROXY still limits failed logins at one name', async () => {
    const booted = await boot({});
    expect(
      await failedLogins(
        booted,
        () => undefined,
        () => 'nobody',
      ),
    ).toEqual([...TEN_REJECTED, 'throttled']);
  });

  /** Pins the database half of the fold: Postgres finds `tobias` under `TOBİAS`, so the two must share a budget. */
  it('counts the spellings the database takes for one account against one budget', async () => {
    const booted = await boot({});
    const registrant = await TestClient.open(booted.url);
    registrant.send(registerFrame('tobias'));
    expect((await registrant.until('registerResult')).target).toEqual({ tag: 'registerResult', payload: { result: 'ok' } });
    await registrant.close();
    const accounts = new PostgresAccountRepository(booted.server.db);
    expect((await accounts.findByName('TOBİAS'))?.name).toBe('tobias');
    expect((await accounts.findByName('TOBIAS'))?.name).toBe('tobias');
    const spellings = ['tobias', 'TOBİAS', 'TOBIAS'];
    expect(
      await failedLogins(
        booted,
        () => undefined,
        (attempt) => spellings[attempt % spellings.length]!,
      ),
    ).toEqual([...TEN_REJECTED, 'throttled']);
  });

  it('SOMNIO_DEV_DEFAULTS=1 leaves the limit off without the error record', async () => {
    const booted = await boot({ SOMNIO_DEV_DEFAULTS: '1' });
    expect(readyRecord(booted)).toMatchObject({ prelogin_limit: 'off' });
    expect(settingErrors(booted)).toEqual([]);
  });
});
