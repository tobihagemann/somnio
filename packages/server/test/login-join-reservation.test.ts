import { describe, expect, it } from 'vitest';
import type { Character } from '@somnio/core';
import { ConnectionActor } from '../src/connection/connectionActor.ts';
import { completeAuthenticatedJoin } from '../src/handlers/login.ts';
import { collectMessages, loginResults } from './support/frames.ts';
import { makeCharacter, makeSector } from './support/sectorFactory.ts';
import { makeStubConnectionDependencies } from './support/stubDependencies.ts';
import { RepositoryFailure, StubCharacterRepository } from './support/stubRepositories.ts';

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
    return { connection, done: completeAuthenticatedJoin(accountId, connection, dependencies, false) };
  };
  const isRegistered = () => !dependencies.worldRouter.register(new ConnectionActor(dependencies), accountId);
  return { characters, join, isRegistered };
}

/**
 * The account is reserved before anything of it is read. A join that read first could load the
 * rows a departing connection's checkpoint is about to replace.
 */
describe("the join's reservation of its account", () => {
  it('holds while the character read is pending, so a second join is answered alreadyLoggedIn before it reads anything', async () => {
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
    expect(first.connection.state.kind).toBe('attached');
  });

  it.each<[string, () => Promise<Character[]>]>([
    ['finds no character', () => Promise.resolve([])],
    ['fails to read the character', () => Promise.reject(new RepositoryFailure())],
  ])('is released by a join that %s', async (_label, answer) => {
    const world = await joining(answer);
    const { connection, done } = world.join();
    await done;
    expect(loginResults(await collectMessages(connection.outbox))).toEqual(['badCredentials']);
    expect(world.isRegistered()).toBe(false);
  });
});
