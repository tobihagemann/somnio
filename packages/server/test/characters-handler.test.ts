import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import type { CreateCharacterMessage } from '@somnio/protocol';
import { headingFromCardinal } from '@somnio/core';
import type { Character, People, Sector } from '@somnio/core';
import { STARTER_SECTOR, newCharacter } from '@somnio/data';
import { interiorSector } from '../../core/test/support/worldFixture.ts';
import { ConnectionActor } from '../src/connection/connectionActor.ts';
import { handleCreateCharacter, joinCharacter, resolvedSpawn } from '../src/handlers/characters.ts';
import { characterResults, collectMessages } from './support/frames.ts';
import { makeCharacter, makeNPC, makeSector } from './support/sectorFactory.ts';
import { makeStubConnectionDependencies } from './support/stubDependencies.ts';
import { StubCharacterRepository } from './support/stubRepositories.ts';

class RecordingCharacterRepository extends StubCharacterRepository {
  creates = 0;

  override create(): Promise<Character> {
    this.creates += 1;
    return Promise.reject(new Error('unused'));
  }
}

const valid: CreateCharacterMessage = { name: 'Ida', people: 'umbrae' };

async function createResult(message: CreateCharacterMessage) {
  const characters = new RecordingCharacterRepository();
  const dependencies = await makeStubConnectionDependencies({ characters });
  const connection = new ConnectionActor(dependencies);
  await handleCreateCharacter(message, crypto.randomUUID(), connection, dependencies);
  return { results: characterResults(await collectMessages(connection.outbox)), creates: characters.creates };
}

/**
 * Refused before the repository: an empty or over-cap name, a people the world does not have, and a
 * name the policy turns away. A name at the cap reaches it.
 */
describe('creating a character', () => {
  it.each(['elves', ''])('fails for the people %j', async (people) => {
    expect(await createResult({ ...valid, people })).toEqual({ results: ['failure'], creates: 0 });
  });

  it('fails for an empty name and a name one two-byte letter past the cap, and reaches the repository at it', async () => {
    expect(await createResult({ ...valid, name: '' })).toEqual({ results: ['failure'], creates: 0 });
    const letters = SOMNIO_PROTOCOL_CONSTANTS.maxIdentifierUTF8Bytes / 2;
    expect(await createResult({ ...valid, name: 'ü'.repeat(letters + 1) })).toEqual({ results: ['failure'], creates: 0 });
    expect((await createResult({ ...valid, name: 'ü'.repeat(letters) })).creates).toBe(1);
  });

  it('answers nameNotAllowed for a mixed-script name', async () => {
    expect(await createResult({ ...valid, name: 'Sаibot' })).toEqual({ results: ['nameNotAllowed'], creates: 0 });
  });
});

/** Lists the account's characters once, creates, and fails every later read, as a database lost right after the commit would. */
class OneReadCharacterRepository extends StubCharacterRepository {
  private reads = 0;

  override findByAccount(accountId: string): Promise<Character[]> {
    this.reads += 1;
    return this.reads === 1 ? super.findByAccount(accountId) : Promise.reject(new Error('database gone'));
  }

  override create(_accountId: string, name: string, people: People): Promise<Character> {
    return Promise.resolve(newCharacter(crypto.randomUUID(), name, people));
  }
}

describe('a character created', () => {
  it("is answered with the account's characters as they were listed, the new one where a list would put it, and ok", async () => {
    const accountId = crypto.randomUUID();
    const played = makeCharacter({ x: 5, z: 5 }, 'Saibot');
    const unplayed = newCharacter(crypto.randomUUID(), 'ida', 'sopors');
    const characters = new OneReadCharacterRepository(new Map([[accountId, [played, unplayed]]]));
    const dependencies = await makeStubConnectionDependencies({ characters });
    const connection = new ConnectionActor(dependencies);

    await handleCreateCharacter({ ...valid, name: 'Zed' }, accountId, connection, dependencies);

    const messages = await collectMessages(connection.outbox);
    expect(characterResults(messages)).toEqual(['ok']);
    const listed = messages.find((message) => message.tag === 'characters');
    expect(listed?.tag === 'characters' ? listed.payload.characters.map((character) => character.name) : undefined).toEqual(['Saibot', 'Zed', 'ida']);
  });
});

const STARTER_SPAWN = { space: STARTER_SECTOR, position: { x: 3, z: 4 }, facing: headingFromCardinal('east') };

/** A world of one outdoor sector and a starter sector whose spawn is at (3, 4), facing east. */
async function router(field: Partial<Sector> = {}) {
  const starter = interiorSector(STARTER_SECTOR, { spawn: { x: 3, z: 4, facing: headingFromCardinal('east') } });
  return (await makeStubConnectionDependencies({ sectors: [makeSector('Field', field), starter] })).worldRouter;
}

describe('resolvedSpawn', () => {
  it('keeps a saved position a player can stand on', async () => {
    const character = makeCharacter({ x: 5, z: 5 });
    expect(resolvedSpawn(character, await router())).toBe(character);
  });

  it('puts a fresh character, stored at the origin sentinel, on the starter spawn', async () => {
    expect(resolvedSpawn(newCharacter(crypto.randomUUID(), 'fresh', 'vigils'), await router())).toEqual(STARTER_SPAWN);
  });

  it.each<[string, Partial<Sector>]>([
    ['inside a collider', { placements: [{ id: 'box-1', modelId: 'box', x: 5, z: 5, yaw: 0, elevation: 0 }] }],
    ['inside a blocker', { blockers: [{ id: 'slab', x: 4, z: 4, width: 2, depth: 2 }] }],
    ['on an NPC', { npcs: [makeNPC('guard', { x: 5.2, z: 5 }, '')] }],
  ])('falls back to the starter spawn from a saved position %s', async (_label, field) => {
    expect(resolvedSpawn(makeCharacter({ x: 5, z: 5 }), await router(field))).toEqual(STARTER_SPAWN);
  });

  it('falls back to the starter spawn from a space the world no longer has', async () => {
    expect(resolvedSpawn(makeCharacter({ x: 5, z: 5 }, 'tester', 'Gone'), await router())).toEqual(STARTER_SPAWN);
  });
});

/** The host clock, which the join reads, stands at `NOW`. */
describe('a join', () => {
  const NOW = Date.UTC(2026, 10, 11, 12);

  afterEach(() => vi.useRealTimers());

  it.each([
    ['now, after a last_seen behind the clock', NOW - 60_000, NOW],
    ['a millisecond after a last_seen the clock has stepped back behind', NOW + 60_000, NOW + 60_001],
  ])('stamps its last_seen %s', async (_label, stored, joined) => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    const characters = new StubCharacterRepository();
    const snapshot = vi.spyOn(characters, 'snapshot');
    const dependencies = await makeStubConnectionDependencies({ characters });
    const character = { ...makeCharacter({ x: 5, z: 5 }), lastSeen: new Date(stored) };

    expect(await joinCharacter(character, crypto.randomUUID(), new ConnectionActor(dependencies), dependencies)).toBe(true);
    expect(snapshot.mock.calls.map(([written]) => written.lastSeen.getTime())).toEqual([joined]);
  });
});
