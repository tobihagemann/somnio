import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import type { CreateCharacterMessage } from '@somnio/protocol';
import { OUTDOOR_SPACE_ID, headingFromCardinal } from '@somnio/core';
import type { Character, People, Sector } from '@somnio/core';
import { STARTER_SECTOR, newCharacter } from '@somnio/data';
import { interiorSector } from '../../core/test/support/worldFixture.ts';
import { ConnectionActor } from '../src/connection/connectionActor.ts';
import { handleCreateCharacter, joinCharacter, resolvedSpawn } from '../src/handlers/characters.ts';
import { MOONSTONE, energyOf, lucidity, payloads, wearing, wounded } from './support/combat.ts';
import { characterResults, collectMessages } from './support/frames.ts';
import { attachPlayer, makeCharacter, makeNPC, makeSector } from './support/sectorFactory.ts';
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
  const dependencies = makeStubConnectionDependencies({ characters });
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
    const dependencies = makeStubConnectionDependencies({ characters });
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
function router(field: Partial<Sector> = {}) {
  const starter = interiorSector(STARTER_SECTOR, { spawn: { x: 3, z: 4, facing: headingFromCardinal('east') } });
  return makeStubConnectionDependencies({ sectors: [makeSector('Field', field), starter] }).worldRouter;
}

describe('resolvedSpawn', () => {
  it('keeps a saved position a player can stand on', () => {
    const character = makeCharacter({ x: 5, z: 5 });
    expect(resolvedSpawn(character, router())).toBe(character);
  });

  it('puts a fresh character, stored at the origin sentinel, on the starter spawn', () => {
    expect(resolvedSpawn(newCharacter(crypto.randomUUID(), 'fresh', 'vigils'), router())).toEqual(STARTER_SPAWN);
  });

  it.each<[string, Partial<Sector>]>([
    ['inside a collider', { placements: [{ id: 'box-1', modelId: 'box', x: 5, z: 5, yaw: 0, elevation: 0 }] }],
    ['inside a blocker', { blockers: [{ id: 'slab', x: 4, z: 4, width: 2, depth: 2 }] }],
    ['on an NPC', { npcs: [makeNPC('guard', { x: 5.2, z: 5 }, {})] }],
  ])('falls back to the starter spawn from a saved position %s', (_label, field) => {
    expect(resolvedSpawn(makeCharacter({ x: 5, z: 5 }), router(field))).toEqual(STARTER_SPAWN);
  });

  it('falls back to the starter spawn from a space the world no longer has', () => {
    expect(resolvedSpawn(makeCharacter({ x: 5, z: 5 }, 'tester', 'Gone'), router())).toEqual(STARTER_SPAWN);
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
    const dependencies = makeStubConnectionDependencies({ characters });
    const character = { ...makeCharacter({ x: 5, z: 5 }), lastSeen: new Date(stored) };

    expect(await joinCharacter(character, crypto.randomUUID(), new ConnectionActor(dependencies), dependencies)).toBe(true);
    expect(snapshot.mock.calls.map(([written]) => written.lastSeen.getTime())).toEqual([joined]);
  });
});

/** What a dreamer carried as they left the world runs on while they are away, and is theirs again when they come back. */
describe('a dreamer who comes back', () => {
  /** A dreamer joined at (5, 5) of a field on a clock the test advances; `leaveFor` disconnects them and joins them again that much later. */
  async function returner(character: Partial<Character> = {}) {
    const clock = { ms: 0 };
    const characters = new StubCharacterRepository();
    const saved = vi.spyOn(characters, 'persistCheckpoint');
    const dependencies = makeStubConnectionDependencies({ sectors: [makeSector('Field')], characters, now: () => clock.ms });
    const worldRouter = dependencies.worldRouter;
    const accountId = crypto.randomUUID();
    const join = async (joining: Character): Promise<ConnectionActor> => {
      const connection = new ConnectionActor(dependencies);
      expect(worldRouter.register(connection, accountId)).toBe(true);
      expect(await joinCharacter(joining, accountId, connection, dependencies)).toBe(true);
      return connection;
    };
    const joined = { ...makeCharacter({ x: 5, z: 5 }, 'returner'), ...character };
    let connection = await join(joined);
    const leaveFor = async (ms: number): Promise<ConnectionActor> => {
      await connection.drainForShutdown();
      clock.ms += ms;
      connection = await join(saved.mock.calls.at(-1)![0]);
      return connection;
    };
    return { clock, space: worldRouter.space(OUTDOOR_SPACE_ID)!, id: joined.id, leaveFor };
  }

  /** Brace's own cooldown is 15 s and its effect 4 s: 2 s on, then 4 s away, leave 9 s and nothing. */
  it('finds its cooldowns run down by the time away, and an effect that ran out meanwhile gone', async () => {
    const r = await returner({ lucidity: lucidity('fighter', { brace: 1 }) });
    r.space.handleUseAbility('brace', r.id);
    r.clock.ms += 2000;
    const back = await r.leaveFor(4000);
    const messages = await collectMessages(back.outbox);
    expect(payloads(messages, 'cooldowns')).toEqual([{ globalSeconds: 0, cooldowns: [{ abilityId: 'brace', seconds: 9 }] }]);
    expect(payloads(messages, 'effects')).toEqual([]);
  });

  /** Renewal's first tick falls a second after it was put on. Left 2.5 s in, its next is half a second off. */
  it('keeps a heal over time with what it had left, paying no tick that fell due while away', async () => {
    const r = await returner(wounded(40));
    const healer = attachPlayer(r.space, { x: 6, z: 5 }, 'healer', {
      character: { lucidity: lucidity('healer', { touch: 2, renewal: 1 }) },
      inventory: wearing(MOONSTONE),
    });
    r.space.handleTarget(r.id, healer.entityId);
    r.space.handleUseAbility('renewal', healer.entityId);
    for (const ms of [1000, 1000]) {
      r.clock.ms += ms;
      r.space.step(0);
    }
    r.clock.ms += 500;
    const back = await r.leaveFor(4000);
    expect(payloads(await collectMessages(back.outbox), 'effects')).toEqual([{ entityId: r.id, effects: [{ effectId: 'renewing', seconds: 3.5 }] }]);
    const health: number[] = [];
    for (const ms of [0, 499, 1]) {
      r.clock.ms += ms;
      r.space.step(0);
      health.push(energyOf(r.space, r.id).healthCurrent);
    }
    expect(health[1]).toBe(health[0]);
    expect(health[2]).toBeGreaterThan(health[1]!);
  });

  /** A second away refills 3.75 m of the allowance and 1.25 s of the pace credit, so a 3.7 m walk runs 2.45 m of it. */
  it('finds the allowance and the pace credit refilled by the time away, not whole', async () => {
    const r = await returner();
    r.space.handleMove({ x: 12.5, z: 5, facing: 90, gait: 'walk' }, r.id);
    const back = await r.leaveFor(1000);
    r.space.handleMove({ x: 16.2, z: 5, facing: 90, gait: 'walk' }, r.id);
    r.space.handleMove({ x: 16.3, z: 5, facing: 90, gait: 'walk' }, r.id);
    expect(r.space.snapshotForPlayer(r.id)?.character.position).toEqual({ x: 16.2, z: 5 });
    expect(payloads(await collectMessages(back.outbox), 'correction')).toEqual([{ x: 16.2, z: 5 }]);
    expect(energyOf(r.space, r.id).balanceCurrent).toBe(92);
  });
});
