import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { NO_LUCIDITY, NO_QUESTS, NO_STATS, fullPools, headingFromCardinal, isPeople, isRole, isTeachingId } from '@somnio/core';
import type { Character, Inventory, Lucidity, People, TeachingRank } from '@somnio/core';
import type { SomnioDatabase } from '../db.ts';
import { confusableSkeleton } from '../namePolicy/namePolicy.ts';
import type { Database } from '../schema.ts';
import { RepositoryDecodingError, isUniqueViolation } from './errors.ts';
import { insertItems } from './items.ts';
import { insertQuests } from './quests.ts';

/** Surfaced from the unique-name constraint race, so the handler answers `nameExists`. */
export class CharacterNameTakenError extends Error {
  constructor() {
    super('character name taken');
    this.name = 'CharacterNameTakenError';
  }
}

/** A character read here holds no quests: its quest log is the quest repository's, loaded on joining. */
export interface CharacterRepository {
  /** Provisions the character with its starting coins and items in one transaction, never played. */
  create(accountId: string, name: string, people: People, starterInventory: Inventory): Promise<Character>;
  /** The account's characters in `compareCharacters` order. */
  findByAccount(accountId: string): Promise<Character[]>;
  findByName(name: string): Promise<Character | undefined>;
  /**
   * Persists the character's own row, leaving its rank rows as they are, skipped when the row's
   * `last_seen` is already at or past the snapshot's — another writer committed fresher state.
   * Returns whether the update landed.
   */
  snapshot(character: Character): Promise<boolean>;
  /**
   * Atomically persists the character with its coins and replaces its rank, item, and quest rows in
   * one transaction, gated by the same `last_seen` skip-if-stale guard. Returns `false` (touching
   * neither) when the character update was skipped as stale.
   */
  persistCheckpoint(character: Character, inventory: Inventory): Promise<boolean>;
  /** Deletes one of the account's characters with its rank, item, and quest rows; `false` when the account has no such character. */
  delete(accountId: string, characterId: string): Promise<boolean>;
}

export const STARTER_SECTOR = 'EdariaLibrary';

/** The `last_seen` of a character created but never played: it sorts last, and any real snapshot is newer. */
const NEVER_PLAYED_MS = 0;

/** Both name constraints answer a taken name, whichever one the database reports first. */
const CHARACTER_NAME_CONSTRAINTS: ReadonlySet<string> = new Set(['characters_name_normalized_key', 'characters_name_skeleton_key']);

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
};

type RankRow = {
  character_id: string;
  teaching_id: string;
  rank: number;
  practice: number;
};

/** Spawn defaults: the starter sector's space, full energy, no role, the `(0, 0)` sentinel the runtime re-resolves, and never played. */
export function newCharacter(id: string, name: string, people: People): Character {
  return {
    id,
    name,
    people,
    space: STARTER_SECTOR,
    position: { x: 0, z: 0 },
    facing: headingFromCardinal('south'),
    energy: fullPools(NO_STATS),
    lucidity: NO_LUCIDITY,
    quests: NO_QUESTS,
    lastSeen: new Date(NEVER_PLAYED_MS),
  };
}

export function hasBeenPlayed(character: Character): boolean {
  return character.lastSeen.getTime() > NEVER_PLAYED_MS;
}

/**
 * The order of an account's characters: most recently played first, so the never played, at the
 * epoch, come last. Ties go by name in code-unit order, which no database collation can change,
 * then by id.
 */
export function compareCharacters(a: Character, b: Character): number {
  return b.lastSeen.getTime() - a.lastSeen.getTime() || compareCodeUnits(a.name, b.name) || compareCodeUnits(a.id, b.id);
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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
  };
}

function decodeCharacter(row: CharacterRow, rankRows: readonly RankRow[]): Character {
  if (!isPeople(row.people)) throw new RepositoryDecodingError('people', row.people);
  return {
    id: row.id,
    name: row.name,
    people: row.people,
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
    quests: NO_QUESTS,
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
  };
}

async function insertCharacter(db: Kysely<Database>, accountId: string, character: Character, coins: number): Promise<void> {
  await db
    .insertInto('characters')
    .values({
      id: character.id,
      account_id: accountId,
      name: character.name,
      ...characterColumns(character),
      name_skeleton: confusableSkeleton(character.name),
      coins,
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

  async create(accountId: string, name: string, people: People, starterInventory: Inventory): Promise<Character> {
    const character = newCharacter(crypto.randomUUID(), name, people);
    try {
      await this.db.transaction().execute(async (transaction) => {
        await insertCharacter(transaction, accountId, character, starterInventory.coins);
        await insertItems(transaction, character.id, starterInventory);
      });
    } catch (error) {
      if (isUniqueViolation(error, CHARACTER_NAME_CONSTRAINTS)) throw new CharacterNameTakenError();
      throw error;
    }
    return character;
  }

  async findByAccount(accountId: string): Promise<Character[]> {
    const rows = await this.db.selectFrom('characters').select(CHARACTER_COLUMNS).where('account_id', '=', accountId).execute();
    return (await this.withRanks(rows)).sort(compareCharacters);
  }

  /** NFKC-only lookup through `name_normalized`; cross-script confusables (`name_skeleton`) are not resolved here. */
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

  persistCheckpoint(character: Character, inventory: Inventory): Promise<boolean> {
    return this.db.transaction().execute(async (transaction) => {
      if (!(await guardedUpdate(transaction, character))) return false;
      await transaction.deleteFrom('character_ranks').where('character_id', '=', character.id).execute();
      for (const held of character.lucidity.ranks) {
        await transaction
          .insertInto('character_ranks')
          .values({ character_id: character.id, teaching_id: held.teachingId, rank: held.rank, practice: held.practice })
          .execute();
      }
      await transaction.updateTable('characters').set({ coins: inventory.coins }).where('id', '=', character.id).execute();
      await transaction.deleteFrom('items').where('character_id', '=', character.id).execute();
      await insertItems(transaction, character.id, inventory);
      await transaction.deleteFrom('character_quests').where('character_id', '=', character.id).execute();
      await insertQuests(transaction, character.id, character.quests);
      return true;
    });
  }

  async delete(accountId: string, characterId: string): Promise<boolean> {
    const deleted = await this.db.deleteFrom('characters').where('id', '=', characterId).where('account_id', '=', accountId).returning('id').execute();
    return deleted.length > 0;
  }
}
