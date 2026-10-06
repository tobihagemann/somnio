import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import type { RegisterMessage } from '@somnio/protocol';
import { PostgresWorldClockRepository, STARTER_SECTOR } from '@somnio/data';
import { ConnectionActor } from '../../src/connection/connectionActor.ts';
import type { ConnectionDependencies } from '../../src/connection/dependencies.ts';
import { handleLogin } from '../../src/handlers/login.ts';
import { handleRegister } from '../../src/handlers/register.ts';
import { collectMessages, loginResults, registerResults } from '../support/frames.ts';
import { TEST_PASSWORD, makeDatabaseDependencies, startDatabase, uniqueNickname } from './support/harness.ts';
import type { DatabaseHarness } from './support/harness.ts';

const SEEDED_WORLD_SECONDS = 16_000_000_000.5;

let harness: DatabaseHarness;
let dependencies: ConnectionDependencies;

beforeAll(async () => {
  harness = await startDatabase();
  // A non-default clock so the per-login `enterSpace` assertion catches a regression to the boot default.
  await new PostgresWorldClockRepository(harness.db).save(SEEDED_WORLD_SECONDS);
  dependencies = await makeDatabaseDependencies(harness.db);
});
afterAll(async () => {
  await harness.stop();
});

function registerMessage(nickname: string, overrides: Partial<RegisterMessage> = {}): RegisterMessage {
  return {
    nickname,
    password: TEST_PASSWORD,
    passwordRepeat: TEST_PASSWORD,
    people: 'lumina',
    email: `${nickname}@example.invalid`,
    ...overrides,
  };
}

async function register(message: RegisterMessage) {
  const connection = new ConnectionActor(dependencies);
  await handleRegister(message, connection, dependencies);
  return registerResults(await collectMessages(connection.outbox));
}

async function login(nickname: string, password = TEST_PASSWORD) {
  const connection = new ConnectionActor(dependencies);
  await handleLogin({ nickname, password }, connection, dependencies);
  return { connection, messages: await collectMessages(connection.outbox) };
}

describe('register handler over Postgres', () => {
  it('success enqueues registerResult ok', async () => {
    expect(await register(registerMessage(uniqueNickname('newcomer')))).toEqual(['ok']);
  });

  it('fails when the password repeat does not match', async () => {
    expect(await register(registerMessage(uniqueNickname('alice'), { passwordRepeat: 'passwordB' }))).toEqual(['failure']);
  });

  it('fails when the password is shorter than the minimum', async () => {
    expect(await register(registerMessage(uniqueNickname('shorty'), { password: 'abc', passwordRepeat: 'abc' }))).toEqual(['failure']);
  });

  it('a duplicate nickname maps to nicknameExists', async () => {
    const nickname = uniqueNickname('duplicate');
    expect(await register(registerMessage(nickname))).toEqual(['ok']);
    expect(await register(registerMessage(nickname.toUpperCase()))).toEqual(['nicknameExists']);
  });

  it('fails when the nickname exceeds the identifier length cap', async () => {
    expect(await register(registerMessage('n'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes + 1)))).toEqual(['failure']);
  });

  it('fails when the email exceeds the identifier length cap', async () => {
    const email = `${'e'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes)}@x.invalid`;
    expect(await register(registerMessage(uniqueNickname('mail'), { email }))).toEqual(['failure']);
  });

  it('a mixed-script name returns nameNotAllowed', async () => {
    expect(await register(registerMessage('Sаibot'))).toEqual(['nameNotAllowed']);
  });

  it('an unknown people returns failure', async () => {
    expect(await register(registerMessage(uniqueNickname('ppl'), { people: 'elves' }))).toEqual(['failure']);
  });
});

describe('login handler over Postgres', () => {
  it('success streams the join sequence starting with the seeded world clock', async () => {
    const nickname = uniqueNickname('loginuser');
    await register(registerMessage(nickname));
    const { connection, messages } = await login(nickname);
    const tags = messages.map((message) => message.tag);
    expect(loginResults(messages)).toEqual(['ok']);
    expect(tags).toContain('sector');
    expect(tags).toContain('inventory');
    expect(tags).toContain('energy');
    // The service has not ticked, so the clock is exactly what the database held.
    expect(messages[1]).toMatchObject({ tag: 'enterSpace', payload: { spaceId: STARTER_SECTOR, worldSeconds: SEEDED_WORLD_SECONDS } });
    if (connection.state.kind === 'attached') dependencies.worldRouter.unregister(connection.state.accountId);
  });

  it('a fresh login into EdariaBibliothek streams the exact join frame order', async () => {
    // A private router, so no player another case left attached adds an entity frame.
    const own = await makeDatabaseDependencies(harness.db);
    const nickname = uniqueNickname('order');
    await register(registerMessage(nickname));
    const connection = new ConnectionActor(own);
    await handleLogin({ nickname, password: TEST_PASSWORD }, connection, own);
    const messages = await collectMessages(connection.outbox);
    expect(messages.map((message) => message.tag)).toEqual(['loginResult', 'enterSpace', 'sector', 'entity', 'inventory', 'energy', 'lucidity', 'entity']);
  });

  it('an unknown nickname returns badCredentials', async () => {
    expect(loginResults((await login(uniqueNickname('ghost'))).messages)).toEqual(['badCredentials']);
  });

  it('a wrong password for an existing account returns badCredentials', async () => {
    const nickname = uniqueNickname('wrongpw');
    await register(registerMessage(nickname));
    expect(loginResults((await login(nickname, 'not-the-password')).messages)).toEqual(['badCredentials']);
  });

  it('a second login for the same account returns alreadyLoggedIn', async () => {
    const nickname = uniqueNickname('twice');
    await register(registerMessage(nickname));
    const first = await login(nickname);
    expect(loginResults(first.messages)).toEqual(['ok']);
    expect(loginResults((await login(nickname)).messages)).toEqual(['alreadyLoggedIn']);
    if (first.connection.state.kind === 'attached') dependencies.worldRouter.unregister(first.connection.state.accountId);
  });

  it('fails when the password exceeds the maximum length', async () => {
    const password = 'p'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxPasswordUTF8Bytes + 1);
    expect(loginResults((await login(uniqueNickname('longpw'), password)).messages)).toEqual(['badCredentials']);
  });

  it('fails when the nickname exceeds the maximum length', async () => {
    const nickname = 'n'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes + 1);
    expect(loginResults((await login(nickname)).messages)).toEqual(['badCredentials']);
  });
});
