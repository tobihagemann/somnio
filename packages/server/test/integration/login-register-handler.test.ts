import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import type { RegisterMessage } from '@somnio/protocol';
import { PostgresWorldClockRepository, STARTER_SECTOR } from '@somnio/data';
import { ConnectionActor } from '../../src/connection/connectionActor.ts';
import type { ConnectionDependencies } from '../../src/connection/dependencies.ts';
import { handleLogin } from '../../src/handlers/login.ts';
import { handleRegister } from '../../src/handlers/register.ts';
import { collectMessages, loginResults, registerResults } from '../support/frames.ts';
import { TEST_PASSWORD, emailFor, makeDatabaseDependencies, startDatabase, uniqueName } from './support/harness.ts';
import type { DatabaseHarness } from './support/harness.ts';

const SEEDED_WORLD_SECONDS = 16_000_000_000.5;

let harness: DatabaseHarness;
let dependencies: ConnectionDependencies;

beforeAll(async () => {
  harness = await startDatabase();
  // A non-default clock so the per-join `enterSpace` assertion catches a regression to the boot default.
  await new PostgresWorldClockRepository(harness.db).save(SEEDED_WORLD_SECONDS);
  dependencies = await makeDatabaseDependencies(harness.db);
});
afterAll(async () => {
  await harness.stop();
});

function registerMessage(email: string, overrides: Partial<RegisterMessage> = {}): RegisterMessage {
  return { email, password: TEST_PASSWORD, passwordRepeat: TEST_PASSWORD, ...overrides };
}

async function register(message: RegisterMessage) {
  const connection = new ConnectionActor(dependencies);
  await handleRegister(message, connection, dependencies);
  return registerResults(await collectMessages(connection.outbox));
}

async function login(email: string, password = TEST_PASSWORD) {
  const connection = new ConnectionActor(dependencies);
  await handleLogin({ email, password }, connection, dependencies);
  return { connection, messages: await collectMessages(connection.outbox) };
}

/** Logs in as the account of the player named `name`, creates their character, and joins as it. */
async function play(name: string, own = dependencies) {
  const connection = new ConnectionActor(own);
  await handleLogin({ email: emailFor(name), password: TEST_PASSWORD }, connection, own);
  if (connection.state.kind !== 'authenticated') throw new Error(`${name} did not log in`);
  await connection.dispatch({ tag: 'createCharacter', payload: { name, people: 'lumina' } });
  const [character] = await own.characters.findByAccount(connection.state.accountId);
  await connection.dispatch({ tag: 'selectCharacter', payload: { characterId: character!.id } });
  return { connection, messages: await collectMessages(connection.outbox) };
}

describe('register handler over Postgres', () => {
  it('success enqueues registerResult ok', async () => {
    expect(await register(registerMessage(emailFor(uniqueName('newcomer'))))).toEqual(['ok']);
  });

  it('fails when the password repeat does not match', async () => {
    expect(await register(registerMessage(emailFor(uniqueName('alice')), { passwordRepeat: 'passwordB' }))).toEqual(['failure']);
  });

  it('fails when the password is shorter than the minimum', async () => {
    expect(await register(registerMessage(emailFor(uniqueName('shorty')), { password: 'abc', passwordRepeat: 'abc' }))).toEqual(['failure']);
  });

  it('a duplicate email in another case maps to emailExists', async () => {
    const email = emailFor(uniqueName('duplicate'));
    expect(await register(registerMessage(email))).toEqual(['ok']);
    expect(await register(registerMessage(email.toUpperCase()))).toEqual(['emailExists']);
  });

  it('fails when the email exceeds the identifier length cap', async () => {
    const email = `${'e'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes)}@x.invalid`;
    expect(await register(registerMessage(email))).toEqual(['failure']);
  });

  it('fails when the email is not an address', async () => {
    expect(await register(registerMessage(uniqueName('nodomain')))).toEqual(['failure']);
  });
});

describe('login handler over Postgres', () => {
  it('success answers ok and the account with no character yet', async () => {
    const email = emailFor(uniqueName('loginuser'));
    await register(registerMessage(email));
    const { connection, messages } = await login(email);
    expect(messages).toEqual([
      { tag: 'loginResult', payload: { result: 'ok' } },
      { tag: 'otherSessions', payload: { count: 0 } },
      { tag: 'characters', payload: { characters: [] } },
    ]);
    if (connection.state.kind === 'authenticated') dependencies.worldRouter.unregister(connection.state.accountId);
  });

  it('a character joins with the seeded world clock', async () => {
    const name = uniqueName('joiner');
    await register(registerMessage(emailFor(name)));
    const { connection, messages } = await play(name);
    // The service has not ticked, so the clock is exactly what the database held.
    expect(messages).toContainEqual({
      tag: 'enterSpace',
      payload: { spaceId: STARTER_SECTOR, selfId: expect.any(String), worldSeconds: SEEDED_WORLD_SECONDS },
    });
    if (connection.state.kind === 'attached') dependencies.worldRouter.unregister(connection.state.accountId);
  });

  it('a fresh character joining EdariaLibrary streams the exact frame order', async () => {
    // A private router, so no player another case left attached adds an entity frame.
    const own = await makeDatabaseDependencies(harness.db);
    const name = uniqueName('order');
    await register(registerMessage(emailFor(name)));
    const { messages } = await play(name, own);
    expect(messages.map((message) => message.tag)).toEqual([
      'loginResult',
      'otherSessions',
      'characters',
      'characters',
      'characterResult',
      'enterSpace',
      'sector',
      'entity',
      'inventory',
      'energy',
      'lucidity',
      'entity',
    ]);
  });

  it('an unknown email returns badCredentials', async () => {
    expect(loginResults((await login(emailFor(uniqueName('ghost')))).messages)).toEqual(['badCredentials']);
  });

  it('a wrong password for an existing account returns badCredentials', async () => {
    const email = emailFor(uniqueName('wrongpw'));
    await register(registerMessage(email));
    expect(loginResults((await login(email, 'not-the-password')).messages)).toEqual(['badCredentials']);
  });

  it('a second login for the same account returns alreadyLoggedIn', async () => {
    const email = emailFor(uniqueName('twice'));
    await register(registerMessage(email));
    const first = await login(email);
    expect(loginResults(first.messages)).toEqual(['ok']);
    expect(loginResults((await login(email)).messages)).toEqual(['alreadyLoggedIn']);
    if (first.connection.state.kind === 'authenticated') dependencies.worldRouter.unregister(first.connection.state.accountId);
  });

  it('fails when the password exceeds the maximum length', async () => {
    const password = 'p'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxPasswordUTF8Bytes + 1);
    expect(loginResults((await login(emailFor(uniqueName('longpw')), password)).messages)).toEqual(['badCredentials']);
  });

  it('fails when the email exceeds the maximum length', async () => {
    const email = `${'e'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes)}@x.invalid`;
    expect(loginResults((await login(email)).messages)).toEqual(['badCredentials']);
  });
});
