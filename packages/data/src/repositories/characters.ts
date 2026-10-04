import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { PEOPLES, headingFromCardinal } from '@somnio/core';
import type { Character, InventoryRow, People } from '@somnio/core';
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
   * Persists `character` over its row, skipped when the row's `last_seen` is already at or past
   * the snapshot's — another writer committed fresher state. Returns whether the update landed.
   */
  snapshot(character: Character): Promise<boolean>;
  /**
   * Atomically persists the character and replaces its inventory rows in one transaction, gated
   * by the same `last_seen` skip-if-stale guard. Returns `false` (touching no inventory) when the
   * character update was skipped as stale.
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
};

/** Spawn defaults: the starter sector's space, full energy, and the `(0, 0)` sentinel the runtime re-resolves. */
export function newCharacter(id: string, name: string, people: People, lastSeen: Date): Character {
  return {
    id,
    name,
    people,
    space: STARTER_SECTOR,
    position: { x: 0, z: 0 },
    facing: headingFromCardinal('south'),
    energy: {
      healthCurrent: 100,
      healthMax: 100,
      balanceCurrent: 100,
      balanceMax: 100,
      spiritCurrent: 100,
      spiritMax: 100,
    },
    lastSeen,
  };
}

function decodeCharacter(row: CharacterRow): Character {
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
    return rows.map(decodeCharacter);
  }

  /** NFKC-only lookup through `name_normalized`, like the account repository's. */
  async findByName(name: string): Promise<Character | undefined> {
    const row = await this.db
      .selectFrom('characters')
      .select(CHARACTER_COLUMNS)
      .where('name_normalized', '=', sql<string>`LOWER(NORMALIZE(${name}, NFKC))`)
      .executeTakeFirst();
    return row === undefined ? undefined : decodeCharacter(row);
  }

  snapshot(character: Character): Promise<boolean> {
    return guardedUpdate(this.db, character);
  }

  persistCheckpoint(character: Character, inventory: readonly InventoryRow[]): Promise<boolean> {
    return this.db.transaction().execute(async (transaction) => {
      if (!(await guardedUpdate(transaction, character))) return false;
      await transaction.deleteFrom('inventory_rows').where('character_id', '=', character.id).execute();
      await insertInventoryRows(transaction, character.id, inventory);
      return true;
    });
  }
}
