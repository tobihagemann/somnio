import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { NO_LUCIDITY, PEOPLES, fullPools, headingFromCardinal, isRole, isTeachingId } from '@somnio/core';
import type { Character, InventoryRow, Lucidity, People, TeachingRank } from '@somnio/core';
import type { SomnioDatabase } from '../db.ts';
import { confusableSkeleton } from '../namePolicy/namePolicy.ts';
import type { Database } from '../schema.ts';
import { RepositoryDecodingError } from './errors.ts';
import { insertInventoryRows } from './inventoryRows.ts';

export interface CharacterRepository {
  create(accountId: string, name: string, people: People): Promise<Character>;
  findByAccount(accountId: string): Promise<Character[]>;
  findByName(name: string): Promise<Character | undefined>;
  /**
   * Persists the character's own row, leaving its rank rows as they are, skipped when the row's
   * `last_seen` is already at or past the snapshot's — another writer committed fresher state.
   * Returns whether the update landed.
   */
  snapshot(character: Character): Promise<boolean>;
  /**
   * Atomically persists the character and replaces its rank and inventory rows in one
   * transaction, gated by the same `last_seen` skip-if-stale guard. Returns `false` (touching
   * neither) when the character update was skipped as stale.
   */
  persistCheckpoint(character: Character, inventory: readonly InventoryRow[]): Promise<boolean>;
}

export const STARTER_SECTOR = 'EdariaBibliothek';

const CHARACTER_COLUMNS = [
  'id',
  'name',
  'people',
  'space',
  'position_x',
  'position_z',
  'facing',
  'health_current',
  'health_max',
  'balance_current',
  'balance_max',
  'spirit_current',
  'spirit_max',
  'last_seen',
  'role',
  'study',
  'task_role',
  'task_teaching',
  'task_progress',
] as const;

type CharacterRow = {
  id: string;
  name: string;
  people: string;
  space: string;
  position_x: number;
  position_z: number;
  facing: number;
  health_current: number;
  health_max: number;
  balance_current: number;
  balance_max: number;
  spirit_current: number;
  spirit_max: number;
  last_seen: Date;
  role: string | null;
  study: string | null;
  task_role: string | null;
  task_teaching: string | null;
  task_progress: number;
};

type RankRow = {
  character_id: string;
  teaching_id: string;
  rank: number;
  practice: number;
};

/** Spawn defaults: the starter sector's space, full energy, no role, and the `(0, 0)` sentinel the runtime re-resolves. */
export function newCharacter(id: string, name: string, people: People, lastSeen: Date): Character {
  return {
    id,
    name,
    people,
    space: STARTER_SECTOR,
    position: { x: 0, z: 0 },
    facing: headingFromCardinal('south'),
    energy: fullPools(NO_LUCIDITY.ranks),
    lucidity: NO_LUCIDITY,
    lastSeen,
  };
}

function decodeRole(field: string, raw: string): NonNullable<Lucidity['role']> {
  if (!isRole(raw)) throw new RepositoryDecodingError(field, raw);
  return raw;
}

function decodeTeachingId(field: string, raw: string): TeachingRank['teachingId'] {
  if (!isTeachingId(raw)) throw new RepositoryDecodingError(field, raw);
  return raw;
}

function decodeLucidity(row: CharacterRow, rankRows: readonly RankRow[]): Lucidity {
  return {
    role: row.role === null ? undefined : decodeRole('role', row.role),
    ranks: rankRows.map((rank) => ({ teachingId: decodeTeachingId('teaching_id', rank.teaching_id), rank: rank.rank, practice: rank.practice })),
    study: row.study === null ? undefined : decodeTeachingId('study', row.study),
    task:
      row.task_role === null
        ? undefined
        : {
            role: decodeRole('task_role', row.task_role),
            teachingId: row.task_teaching === null ? undefined : decodeTeachingId('task_teaching', row.task_teaching),
            progress: row.task_progress,
          },
  };
}

function decodeCharacter(row: CharacterRow, rankRows: readonly RankRow[]): Character {
  const people = PEOPLES.find((candidate) => candidate === row.people);
  if (people === undefined) {
    throw new RepositoryDecodingError('people', row.people);
  }
  return {
    id: row.id,
    name: row.name,
    people,
    space: row.space,
    position: { x: row.position_x, z: row.position_z },
    facing: row.facing,
    energy: {
      healthCurrent: row.health_current,
      healthMax: row.health_max,
      balanceCurrent: row.balance_current,
      balanceMax: row.balance_max,
      spiritCurrent: row.spirit_current,
      spiritMax: row.spirit_max,
    },
    lucidity: decodeLucidity(row, rankRows),
    lastSeen: row.last_seen,
  };
}

function characterColumns(character: Character) {
  return {
    people: character.people,
    space: character.space,
    position_x: character.position.x,
    position_z: character.position.z,
    facing: character.facing,
    health_current: character.energy.healthCurrent,
    health_max: character.energy.healthMax,
    balance_current: character.energy.balanceCurrent,
    balance_max: character.energy.balanceMax,
    spirit_current: character.energy.spiritCurrent,
    spirit_max: character.energy.spiritMax,
    last_seen: character.lastSeen,
    role: character.lucidity.role ?? null,
    study: character.lucidity.study ?? null,
    task_role: character.lucidity.task?.role ?? null,
    task_teaching: character.lucidity.task?.teachingId ?? null,
    task_progress: character.lucidity.task?.progress ?? 0,
  };
}

export async function insertCharacter(db: Kysely<Database>, accountId: string, character: Character): Promise<void> {
  await db
    .insertInto('characters')
    .values({
      id: character.id,
      account_id: accountId,
      name: character.name,
      ...characterColumns(character),
      name_skeleton: confusableSkeleton(character.name),
    })
    .execute();
}

/**
 * The guarded update both persistence paths share: `RETURNING id` so the row count comes back
 * through the result rows, and `last_seen <` so an older snapshot never overwrites a newer one.
 */
async function guardedUpdate(db: Kysely<Database>, character: Character): Promise<boolean> {
  const updated = await db
    .updateTable('characters')
    .set(characterColumns(character))
    .where('id', '=', character.id)
    .where('last_seen', '<', character.lastSeen)
    .returning('id')
    .execute();
  return updated.length > 0;
}

export class PostgresCharacterRepository implements CharacterRepository {
  private readonly db: SomnioDatabase;

  constructor(db: SomnioDatabase) {
    this.db = db;
  }

  async create(accountId: string, name: string, people: People): Promise<Character> {
    const character = newCharacter(crypto.randomUUID(), name, people, new Date());
    await insertCharacter(this.db, accountId, character);
    return character;
  }

  async findByAccount(accountId: string): Promise<Character[]> {
    const rows = await this.db.selectFrom('characters').select(CHARACTER_COLUMNS).where('account_id', '=', accountId).orderBy('name').execute();
    return this.withRanks(rows);
  }

  /** NFKC-only lookup through `name_normalized`, like the account repository's. */
  async findByName(name: string): Promise<Character | undefined> {
    const row = await this.db
      .selectFrom('characters')
      .select(CHARACTER_COLUMNS)
      .where('name_normalized', '=', sql<string>`LOWER(NORMALIZE(${name}, NFKC))`)
      .executeTakeFirst();
    return row === undefined ? undefined : (await this.withRanks([row]))[0];
  }

  /** Decodes the rows with each one's rank rows, ordered so a character reads back the same every time. */
  private async withRanks(rows: readonly CharacterRow[]): Promise<Character[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const rankRows = await this.db.selectFrom('character_ranks').selectAll().where('character_id', 'in', ids).orderBy('teaching_id').execute();
    return rows.map((row) =>
      decodeCharacter(
        row,
        rankRows.filter((rank) => rank.character_id === row.id),
      ),
    );
  }

  snapshot(character: Character): Promise<boolean> {
    return guardedUpdate(this.db, character);
  }

  persistCheckpoint(character: Character, inventory: readonly InventoryRow[]): Promise<boolean> {
    return this.db.transaction().execute(async (transaction) => {
      if (!(await guardedUpdate(transaction, character))) return false;
      await transaction.deleteFrom('character_ranks').where('character_id', '=', character.id).execute();
      for (const held of character.lucidity.ranks) {
        await transaction
          .insertInto('character_ranks')
          .values({ character_id: character.id, teaching_id: held.teachingId, rank: held.rank, practice: held.practice })
          .execute();
      }
      await transaction.deleteFrom('inventory_rows').where('character_id', '=', character.id).execute();
      await insertInventoryRows(transaction, character.id, inventory);
      return true;
    });
  }
}
