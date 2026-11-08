import { describe, expect, it } from 'vitest';
import type { Character } from '@somnio/core';
import { CLOSE_TRY_AGAIN_LATER, ConnectionActor, TOO_MANY_CHOOSING } from '../src/connection/connectionActor.ts';
import { SocketAdmission } from '../src/connection/socketAdmission.ts';
import type { SocketReservation } from '../src/connection/socketAdmission.ts';
import { completeAuthentication } from '../src/handlers/login.ts';
import { emailFor } from './support/characterCard.ts';
import { collectMessages, loginResults } from './support/frames.ts';
import { testLogger } from './support/logger.ts';
import { makeAuthenticatedWorld } from './support/oneSectorWorld.ts';
import { makeCharacter, makeSector } from './support/sectorFactory.ts';
import { makeStubConnectionDependencies } from './support/stubDependencies.ts';
import { RepositoryFailure, StubCharacterRepository, StubSessionRepository } from './support/stubRepositories.ts';

/** A character repository whose read answers what the test hands it, when the test does. */
class ScriptedCharacterRepository extends StubCharacterRepository {
  reads = 0;
  private readonly answer: () => Promise<Character[]>;

  constructor(answer: () => Promise<Character[]>) {
    super();
    this.answer = answer;
  }

  override findByAccount(): Promise<Character[]> {
    this.reads += 1;
    return this.answer();
  }
}

async function joining(answer: () => Promise<Character[]>) {
  const characters = new ScriptedCharacterRepository(answer);
  const dependencies = await makeStubConnectionDependencies({ sectors: [makeSector('A')], characters });
  const accountId = crypto.randomUUID();
  const join = () => {
    const connection = new ConnectionActor(dependencies);
    return { connection, done: completeAuthentication(accountId, connection, dependencies, false, 'en') };
  };
  const isRegistered = () => !dependencies.worldRouter.register(new ConnectionActor(dependencies), accountId);
  return { characters, join, isRegistered };
}

/**
 * The account is reserved before anything of it is read. An authentication that read first could
 * load the rows a departing connection's checkpoint is about to replace.
 */
describe("the authentication's reservation of its account", () => {
  it('holds while the character read is pending, so a second login is answered alreadyLoggedIn before it reads anything', async () => {
    let release!: (characters: Character[]) => void;
    const pending = new Promise<Character[]>((resolve) => {
      release = resolve;
    });
    const world = await joining(() => pending);
    const first = world.join();
    const second = world.join();
    await second.done;
    expect(loginResults(await collectMessages(second.connection.outbox))).toEqual(['alreadyLoggedIn']);
    expect(world.characters.reads).toBe(1);

    release([makeCharacter({ x: 5, z: 5 })]);
    await first.done;
    expect(loginResults(await collectMessages(first.connection.outbox))).toEqual(['ok']);
    expect(first.connection.state.kind).toBe('authenticated');
    expect(world.isRegistered()).toBe(true);
  });

  it('is released by an authentication that fails to read the characters', async () => {
    const world = await joining(() => Promise.reject(new RepositoryFailure()));
    const { connection, done } = world.join();
    await done;
    expect(loginResults(await collectMessages(connection.outbox))).toEqual(['badCredentials']);
    expect(world.isRegistered()).toBe(false);
  });

  /** Through `dispatch` with a password login, so the 1013 close must pass from `completeAuthentication` back out through `handleLogin`. */
  it('is released by an authentication refused for want of room on the card, which the login answers with the 1013 close', async () => {
    const world = await makeAuthenticatedWorld({ sessions: new StubSessionRepository(), name: 'crowded', password: 'hunter2-long' });
    const admission = new SocketAdmission({
      perAddressEnabled: false,
      perAddress: 1,
      total: 1,
      authenticatedPerAddress: 0,
      authenticated: 0,
      logger: testLogger(),
    });
    const connection = new ConnectionActor(world.dependencies, undefined, admission.reserve(undefined) as SocketReservation);

    const decision = await connection.dispatch({ tag: 'login', payload: { email: emailFor('crowded'), password: 'hunter2-long' } });

    expect(decision).toEqual({ kind: 'close', code: CLOSE_TRY_AGAIN_LATER, reason: TOO_MANY_CHOOSING });
    expect(loginResults(await collectMessages(connection.outbox))).toEqual([]);
    expect(world.dependencies.worldRouter.register(new ConnectionActor(world.dependencies), world.accountId)).toBe(true);
  });
});
