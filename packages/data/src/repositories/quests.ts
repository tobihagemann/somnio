import type { Kysely } from 'kysely';
import { bountyFromJSON, bountyIdOf, bountyQuest, isBountyId, isQuestId, quest } from '@somnio/core';
import type { ActiveQuest, QuestLog, QuestOrBountyId } from '@somnio/core';
import type { SomnioDatabase } from '../db.ts';
import type { Database } from '../schema.ts';
import { RepositoryDecodingError } from './errors.ts';

/** A character's quest log is written only with the character, through `persistCheckpoint`. */
export interface QuestRepository {
  /**
   * The quests the character holds and those they turned in, each list in the order it was stored.
   * The bounties turned in on an earlier day are dropped as the character joins a space.
   */
  load(characterId: string): Promise<QuestLog>;
}

export class PostgresQuestRepository implements QuestRepository {
  private readonly db: SomnioDatabase;

  constructor(db: SomnioDatabase) {
    this.db = db;
  }

  async load(characterId: string): Promise<QuestLog> {
    const rows = await this.db
      .selectFrom('character_quests')
      .select(['quest_id', 'state', 'progress', 'definition'])
      .where('character_id', '=', characterId)
      .orderBy('place')
      .execute();
    const active: ActiveQuest[] = [];
    const done: QuestOrBountyId[] = [];
    for (const row of rows) {
      const questId = decodeQuestId(row.quest_id);
      if (row.state === 'active') active.push(decodeHeld(questId, row.progress, row.definition));
      else if (row.state === 'done') done.push(questId);
      else throw new RepositoryDecodingError('state', row.state);
    }
    return { active, done };
  }
}

function decodeQuestId(raw: string): QuestOrBountyId {
  if (!isQuestId(raw) && !isBountyId(raw)) throw new RepositoryDecodingError('quest_id', raw);
  return raw;
}

/** A held quest: a bounty by the definition it was taken by, which must be the one its id names, and a committed quest by none. */
function decodeHeld(questId: QuestOrBountyId, progress: unknown, definition: unknown): ActiveQuest {
  if (isQuestId(questId)) {
    if (definition !== null) throw new RepositoryDecodingError('definition', JSON.stringify(definition));
    return { questId, progress: decodeProgress(progress, quest(questId).objectives.length) };
  }
  const bounty = bountyFromJSON(definition);
  if (bounty === undefined || bountyIdOf(bounty) !== questId) throw new RepositoryDecodingError('definition', JSON.stringify(definition));
  return { questId, progress: decodeProgress(progress, bountyQuest(bounty).objectives.length), definition: bounty };
}

/** One count, never below nothing, for each of the quest's objectives. */
function decodeProgress(raw: unknown, objectives: number): number[] {
  const sound =
    Array.isArray(raw) && raw.length === objectives && raw.every((value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  if (!sound) throw new RepositoryDecodingError('progress', JSON.stringify(raw));
  return raw as number[];
}

/**
 * Writes each quest of the log as a row of the character's: the held with their progress, a bounty
 * with its definition too, then the turned in, each at its place in its list.
 */
export async function insertQuests(db: Kysely<Database>, characterId: string, quests: QuestLog): Promise<void> {
  const active = quests.active.map(({ questId, progress, definition }, place) => ({
    quest_id: questId,
    state: 'active',
    place,
    progress: JSON.stringify(progress),
    definition: definition === undefined ? null : JSON.stringify(definition),
  }));
  const done = quests.done.map((questId, place) => ({ quest_id: questId, state: 'done', place, progress: null, definition: null }));
  const rows = [...active, ...done].map((row) => ({ character_id: characterId, ...row }));
  if (rows.length > 0) await db.insertInto('character_quests').values(rows).execute();
}
