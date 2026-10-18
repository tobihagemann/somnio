import { describe, expect, it } from 'vitest';
import type { LoginResult, RegisterMessage, RegisterResult } from '@somnio/protocol';
import type { Account } from '@somnio/core';
import { RegistrationError } from '@somnio/data';
import type { RegistrationRequest } from '@somnio/data';
import { ConnectionActor } from '../src/connection/connectionActor.ts';
import type { ConnectionDependencies } from '../src/connection/dependencies.ts';
import { handleLogin } from '../src/handlers/login.ts';
import { handleRegister } from '../src/handlers/register.ts';
import { handleRedeem } from '../src/handlers/session.ts';
import { VALID_REGISTER_MESSAGE, collectMessages, loginResults, registerResults } from './support/frames.ts';
import { makeAuthenticatedWorld, makeOneSectorWorld } from './support/oneSectorWorld.ts';
import { makeCharacter } from './support/sectorFactory.ts';
import { enabledAttemptLimiter, makeStubConnectionDependencies } from './support/stubDependencies.ts';
import { RepositoryFailure, StubAccountRepository, StubRegistrationRepository, StubSessionRepository, makeAccount } from './support/stubRepositories.ts';

const ADDRESS = '203.0.113.7';
const PASSWORD = 'hunter2-long';

/** One attempt per connection, as the browser client makes them: it closes its socket after every failed login. */
async function login(dependencies: ConnectionDependencies, nickname: string, password: string, address = ADDRESS): Promise<LoginResult[]> {
  const connection = new ConnectionActor(dependencies, address);
  await handleLogin({ nickname, password }, connection, dependencies);
  return loginResults(await collectMessages(connection.outbox));
}

async function failedLogins(dependencies: ConnectionDependencies, count: number): Promise<LoginResult[]> {
  const results: LoginResult[] = [];
  for (let attempt = 0; attempt < count; attempt += 1) results.push(...(await login(dependencies, 'nobody', 'wrong-password')));
  return results;
}

async function redeem(dependencies: ConnectionDependencies, token: string): Promise<LoginResult | undefined> {
  const connection = new ConnectionActor(dependencies, ADDRESS);
  await handleRedeem({ token }, connection, dependencies);
  return loginResults(await collectMessages(connection.outbox))[0];
}

const TEN_REJECTED = Array<LoginResult>(10).fill('badCredentials');

describe('the pre-login limit on logins', () => {
  it('answers the eleventh failed login throttled without looking the account up', async () => {
    const accounts = new StubAccountRepository();
    const dependencies = await makeStubConnectionDependencies({ accounts, attemptLimiter: enabledAttemptLimiter() });
    expect(await failedLogins(dependencies, 11)).toEqual([...TEN_REJECTED, 'throttled']);
    expect(accounts.findByNameCallCount).toBe(10);
  });

  it('never throttles a login whose password verifies', async () => {
    const world = await makeAuthenticatedWorld({
      sessions: new StubSessionRepository(),
      name: 'asker',
      password: PASSWORD,
      attemptLimiter: enabledAttemptLimiter(),
    });
    const results: LoginResult[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) results.push(...(await login(world.dependencies, 'asker', PASSWORD)));
    // The first join holds the account's slot, so every later one is refused by the router, not the limiter.
    expect(results).toEqual(['ok', ...Array<LoginResult>(10).fill('alreadyLoggedIn')]);
  });

  /** Two attempts given back for the one admitted would leave the last failure answered `badCredentials`. */
  it('gives a verified login back exactly the one attempt it spent', async () => {
    const world = await makeAuthenticatedWorld({
      sessions: new StubSessionRepository(),
      name: 'asker',
      password: PASSWORD,
      attemptLimiter: enabledAttemptLimiter(),
    });
    expect(await failedLogins(world.dependencies, 9)).toEqual(TEN_REJECTED.slice(0, 9));
    expect(await login(world.dependencies, 'asker', PASSWORD)).toEqual(['ok']);
    expect(await failedLogins(world.dependencies, 2)).toEqual(['badCredentials', 'throttled']);
  });

  /** Counted like any failure: a refund here would make every attempt free while the database is failing. */
  it('counts a login whose lookup throws', async () => {
    class FailingAccountRepository extends StubAccountRepository {
      override findByName(): Promise<Account | undefined> {
        return Promise.reject(new RepositoryFailure());
      }
    }
    const dependencies = await makeStubConnectionDependencies({ accounts: new FailingAccountRepository(), attemptLimiter: enabledAttemptLimiter() });
    expect(await failedLogins(dependencies, 11)).toEqual([...TEN_REJECTED, 'throttled']);
  });
});

/** Ten failed logins spread over `nicknames` in turn, each from an address of its own. */
async function spreadFailures(dependencies: ConnectionDependencies, nicknames: readonly string[]): Promise<LoginResult[]> {
  const results: LoginResult[] = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    results.push(...(await login(dependencies, nicknames[attempt % nicknames.length]!, 'wrong-password', `198.51.100.${attempt}`)));
  }
  return results;
}

const FRESH_ADDRESS = '192.0.2.1';

describe('the account budget on logins', () => {
  async function accountLimited(accounts = new StubAccountRepository()) {
    return { accounts, dependencies: await makeStubConnectionDependencies({ accounts, accountLimiter: enabledAttemptLimiter() }) };
  }

  it('answers the eleventh failed login at a known account throttled from any address, without looking it up', async () => {
    const accounts = new StubAccountRepository(new Map([['alice', makeAccount({ name: 'alice' })]]));
    const { dependencies } = await accountLimited(accounts);
    expect(await spreadFailures(dependencies, ['alice'])).toEqual(TEN_REJECTED);
    expect(await login(dependencies, 'alice', 'wrong-password', FRESH_ADDRESS)).toEqual(['throttled']);
    expect(accounts.findByNameCallCount).toBe(10);
  });

  it('throttles a name no account holds the same way', async () => {
    const { accounts, dependencies } = await accountLimited();
    expect(await spreadFailures(dependencies, ['nobody'])).toEqual(TEN_REJECTED);
    expect(await login(dependencies, 'nobody', 'wrong-password', FRESH_ADDRESS)).toEqual(['throttled']);
    expect(accounts.findByNameCallCount).toBe(10);
  });

  it('counts the spellings of one name against one budget', async () => {
    const { accounts, dependencies } = await accountLimited();
    expect(await spreadFailures(dependencies, ['alice', 'ALICE', 'ＡＬＩＣＥ'])).toEqual(TEN_REJECTED);
    expect(await login(dependencies, 'Alice', 'wrong-password', FRESH_ADDRESS)).toEqual(['throttled']);
    expect(accounts.findByNameCallCount).toBe(10);
  });

  /** Postgres lowercases each character on its own, so `İ` and a word-final `Σ` name the same account as their plain forms. */
  it.each([
    ['tobias', 'TOBİAS'],
    ['ΟΔΥΣΣΕΥΣ', 'οδυσσευσ'],
  ])('folds %s and %s into one budget as the database does', async (spent, throttled) => {
    const { dependencies } = await accountLimited();
    expect(await spreadFailures(dependencies, [spent])).toEqual(TEN_REJECTED);
    expect(await login(dependencies, throttled, 'wrong-password', FRESH_ADDRESS)).toEqual(['throttled']);
  });

  it('gives a verified login back the account attempt it spent', async () => {
    const world = await makeAuthenticatedWorld({
      sessions: new StubSessionRepository(),
      name: 'asker',
      password: PASSWORD,
      accountLimiter: enabledAttemptLimiter(),
    });
    for (let attempt = 0; attempt < 9; attempt += 1) {
      expect(await login(world.dependencies, 'asker', 'wrong-password', `198.51.100.${attempt}`)).toEqual(['badCredentials']);
    }
    expect(await login(world.dependencies, 'asker', PASSWORD, FRESH_ADDRESS)).toEqual(['ok']);
    expect(await login(world.dependencies, 'asker', 'wrong-password', '192.0.2.2')).toEqual(['badCredentials']);
  });

  it('spends no account budget on a login its address budget refused', async () => {
    const dependencies = await makeStubConnectionDependencies({ attemptLimiter: enabledAttemptLimiter(), accountLimiter: enabledAttemptLimiter() });
    for (let attempt = 0; attempt < 10; attempt += 1) await login(dependencies, `nobody-${attempt}`, 'wrong-password');
    for (let attempt = 0; attempt < 10; attempt += 1) expect(await login(dependencies, 'alice', 'wrong-password')).toEqual(['throttled']);
    expect(await login(dependencies, 'alice', 'wrong-password', FRESH_ADDRESS)).toEqual(['badCredentials']);
  });

  it('refuses a nickname with a control character before either budget or the lookup', async () => {
    const accounts = new StubAccountRepository();
    const dependencies = await makeStubConnectionDependencies({ accounts, attemptLimiter: enabledAttemptLimiter(), accountLimiter: enabledAttemptLimiter() });
    for (let attempt = 0; attempt < 11; attempt += 1) expect(await login(dependencies, 'no\u0000body', 'wrong-password')).toEqual(['badCredentials']);
    expect(accounts.findByNameCallCount).toBe(0);
    expect(await login(dependencies, 'nobody', 'wrong-password')).toEqual(['badCredentials']);
  });

  it('answers a resume on its token while the account is throttled', async () => {
    const sessions = new StubSessionRepository();
    const world = await makeOneSectorWorld({ sessions, accountLimiter: enabledAttemptLimiter() });
    const issued = await sessions.issue(world.accountId, 3600);
    expect(await spreadFailures(world.dependencies, ['tester'])).toEqual(TEN_REJECTED);
    expect(await login(world.dependencies, 'tester', 'wrong-password', FRESH_ADDRESS)).toEqual(['throttled']);
    expect(await redeem(world.dependencies, issued.token)).toBe('ok');
  });
});

describe('the pre-login limit leaves session resumes alone', () => {
  it('answers a resume on its token while the address is throttled', async () => {
    const sessions = new StubSessionRepository();
    const world = await makeOneSectorWorld({ sessions, attemptLimiter: enabledAttemptLimiter() });
    const issued = await sessions.issue(world.accountId, 3600);
    expect(await failedLogins(world.dependencies, 11)).toEqual([...TEN_REJECTED, 'throttled']);

    expect(await redeem(world.dependencies, 'no-such-token')).toBe('badCredentials');
    expect(await redeem(world.dependencies, issued.token)).toBe('ok');
  });

  it('spends nothing on a failed resume', async () => {
    const dependencies = await makeStubConnectionDependencies({ attemptLimiter: enabledAttemptLimiter() });
    for (let attempt = 0; attempt < 11; attempt += 1) expect(await redeem(dependencies, 'no-such-token')).toBe('badCredentials');
    expect(await failedLogins(dependencies, 11)).toEqual([...TEN_REJECTED, 'throttled']);
  });
});

/** Answers every registration the same way, so a suite can drive each outcome the handler maps. */
class ScriptedRegistrationRepository extends StubRegistrationRepository {
  private readonly outcome: RegisterResult;

  constructor(outcome: RegisterResult) {
    super();
    this.outcome = outcome;
  }

  override register(request: RegistrationRequest) {
    if (this.outcome === 'ok') return Promise.resolve({ account: makeAccount({ name: request.name }), character: makeCharacter({ x: 0, z: 0 }, request.name) });
    return Promise.reject(this.outcome === 'nicknameExists' ? new RegistrationError() : new RepositoryFailure());
  }
}

const valid = VALID_REGISTER_MESSAGE;

async function registrations(dependencies: ConnectionDependencies, message: RegisterMessage, count: number): Promise<RegisterResult[]> {
  const results: RegisterResult[] = [];
  for (let attempt = 0; attempt < count; attempt += 1) {
    const connection = new ConnectionActor(dependencies, ADDRESS);
    await handleRegister(message, connection, dependencies);
    results.push(...registerResults(await collectMessages(connection.outbox)));
  }
  return results;
}

async function registrationDependencies(outcome: RegisterResult): Promise<ConnectionDependencies> {
  return { ...(await makeStubConnectionDependencies({ attemptLimiter: enabledAttemptLimiter() })), registrations: new ScriptedRegistrationRepository(outcome) };
}

describe('the pre-login limit on registrations', () => {
  it.each(['ok', 'nicknameExists', 'failure'] as const)('counts ten registrations answered %s and throttles the eleventh', async (outcome) => {
    const dependencies = await registrationDependencies(outcome);
    expect(await registrations(dependencies, valid, 11)).toEqual([...Array<RegisterResult>(10).fill(outcome), 'throttled']);
  });

  it('counts no attempt that fails validation before the hash', async () => {
    const dependencies = await registrationDependencies('ok');
    expect(await registrations(dependencies, { ...valid, passwordRepeat: 'other-password' }, 11)).toEqual(Array<RegisterResult>(11).fill('failure'));
    // A Cyrillic `а` among Latin letters, which the name policy refuses.
    expect(await registrations(dependencies, { ...valid, nickname: 'Sаibot' }, 11)).toEqual(Array<RegisterResult>(11).fill('nameNotAllowed'));
    expect(await registrations(dependencies, valid, 1)).toEqual(['ok']);
  });

  it('draws on a budget of its own', async () => {
    const dependencies = await registrationDependencies('ok');
    expect(await failedLogins(dependencies, 11)).toEqual([...TEN_REJECTED, 'throttled']);
    expect(await registrations(dependencies, valid, 1)).toEqual(['ok']);
  });
});
