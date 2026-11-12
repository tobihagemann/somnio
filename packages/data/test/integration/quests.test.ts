import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NO_QUESTS, bountyIdOf } from '@somnio/core';
import type { Bounty, Character, Inventory, QuestLog } from '@somnio/core';
import { PostgresAccountRepository } from '../../src/repositories/accounts.ts';
import { PostgresCharacterRepository } from '../../src/repositories/characters.ts';
import { RepositoryDecodingError } from '../../src/repositories/errors.ts';
import { PostgresQuestRepository } from '../../src/repositories/quests.ts';
import { startDatabase } from './support/harness.ts';
import type { DatabaseHarness } from './support/harness.ts';

const NOTHING: Inventory = { coins: 0, equipped: {}, bag: [] };

/** The world day `TODAYS` is offered on. `BOUNTY` is the day before's. */
const TODAY = 168_000;

const BOUNTY: Bounty = {
  day: TODAY - 1,
  land: 'Graveyard',
  monsterKind: 'skeleton-warrior',
  objective: 'collect',
  count: 4,
  reward: { coins: 120, gear: 3 },
};
const TODAYS: Bounty = { ...BOUNTY, day: TODAY, monsterKind: 'skeleton-minion', objective: 'driveOff', count: 8, reward: { coins: 112, gear: 3 } };

const HELD: QuestLog = {
  active: [
    { questId: 'mystic-trial', progress: [1, 0, 1] },
    { questId: 'drawing-back-task', progress: [22.5] },
  ],
  done: ['healer-trial', 'fighter-trial'],
};

describe('quest repository', () => {
  let harness: DatabaseHarness;
  let accounts: PostgresAccountRepository;
  let characters: PostgresCharacterRepository;
  let quests: PostgresQuestRepository;
  let counter = 0;

  async function newCharacter(): Promise<Character> {
    counter += 1;
    const account = await accounts.create(`quest-holder-${counter}@example.com`, 'h');
    return characters.create(account.id, `Holder ${counter}`, 'vigils', NOTHING);
  }

  /** Stores the quest log through a checkpoint, as the server saves it. */
  async function checkpoint(character: Character, log: QuestLog): Promise<void> {
    counter += 1;
    expect(await characters.persistCheckpoint({ ...character, quests: log, lastSeen: new Date(character.lastSeen.getTime() + counter * 1000) }, NOTHING)).toBe(
      true,
    );
  }

  beforeAll(async () => {
    harness = await startDatabase();
    accounts = new PostgresAccountRepository(harness.db);
    characters = new PostgresCharacterRepository(harness.db);
    quests = new PostgresQuestRepository(harness.db);
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('saves and reloads the quests held with their progress and those turned in, each in the order stored', async () => {
    const character = await newCharacter();
    await checkpoint(character, HELD);
    expect(await quests.load(character.id)).toEqual(HELD);
  });

  it('saves and reloads a bounty held with the definition it was taken by, and every bounty turned in, whatever its day', async () => {
    const character = await newCharacter();
    const yesterday = { ...TODAYS, day: TODAY - 1 };
    const log: QuestLog = {
      active: [{ questId: bountyIdOf(BOUNTY), progress: [2], definition: BOUNTY }],
      done: [bountyIdOf(yesterday), 'fighter-trial', bountyIdOf(TODAYS)],
    };
    await checkpoint(character, log);
    expect(await quests.load(character.id)).toEqual(log);
  });

  it('replaces the quests with each checkpoint, an empty one included', async () => {
    const character = await newCharacter();
    await checkpoint(character, HELD);
    const later: QuestLog = { active: [{ questId: 'drawing-back-task', progress: [60] }], done: ['healer-trial'] };
    await checkpoint(character, later);
    expect(await quests.load(character.id)).toEqual(later);
    await checkpoint(character, NO_QUESTS);
    expect(await quests.load(character.id)).toEqual(NO_QUESTS);
  });

  it.each([
    ['an unknown state', sql`UPDATE character_quests SET state = 'abandoned'`],
    ['a held quest without progress', sql`UPDATE character_quests SET progress = NULL`],
    ['a turned-in quest with progress', sql`UPDATE character_quests SET state = 'done', place = 5`],
    ['a place below the first', sql`UPDATE character_quests SET place = -1`],
    ['one quest both held and turned in', sql`UPDATE character_quests SET quest_id = 'healer-trial'`],
  ])('refuses %s through the constraints', async (_label, corrupt) => {
    const character = await newCharacter();
    await checkpoint(character, { active: [{ questId: 'fighter-trial', progress: [0] }], done: ['healer-trial'] });
    await expect(sql`${corrupt} WHERE character_id = ${character.id} AND state = 'active'`.execute(harness.db)).rejects.toThrow();
  });

  it.each([
    ['a quest it does not know', sql`UPDATE character_quests SET quest_id = 'slay-the-dragon'`],
    ['progress that is no list', sql`UPDATE character_quests SET progress = '{"count": 1}'`],
    ['progress for fewer objectives than the quest has', sql`UPDATE character_quests SET progress = '[1, 0]'`],
    ['progress below nothing', sql`UPDATE character_quests SET progress = '[1, -1, 0]'`],
    ['progress that is no number', sql`UPDATE character_quests SET progress = '[1, "0", 0]'`],
  ])('throws on %s', async (_label, corrupt) => {
    const character = await newCharacter();
    await checkpoint(character, { active: [{ questId: 'mystic-trial', progress: [1, 0, 0] }], done: [] });
    await sql`${corrupt} WHERE character_id = ${character.id}`.execute(harness.db);
    await expect(quests.load(character.id)).rejects.toThrow(RepositoryDecodingError);
  });

  it.each([
    ['a bounty held without its definition', sql`UPDATE character_quests SET definition = NULL`],
    [
      'a bounty held by a definition that is not the one its id names',
      sql`UPDATE character_quests SET definition = jsonb_set(definition, '{monsterKind}', '"ghost"')`,
    ],
    [
      'a bounty held by a definition of a kind no bounty names',
      sql`UPDATE character_quests SET definition = jsonb_set(definition, '{monsterKind}', '"necromancer"')`,
    ],
    ['a bounty held by a definition that is no bounty', sql`UPDATE character_quests SET definition = '{"count": 4}'`],
    ['progress for more objectives than the bounty has', sql`UPDATE character_quests SET progress = '[1, 0]'`],
    ['a committed quest held with a definition', sql`UPDATE character_quests SET quest_id = 'restless-graves'`],
  ])('throws on %s', async (_label, corrupt) => {
    const character = await newCharacter();
    await checkpoint(character, { active: [{ questId: bountyIdOf(BOUNTY), progress: [1], definition: BOUNTY }], done: [] });
    await sql`${corrupt} WHERE character_id = ${character.id}`.execute(harness.db);
    await expect(quests.load(character.id)).rejects.toThrow(RepositoryDecodingError);
  });
});
