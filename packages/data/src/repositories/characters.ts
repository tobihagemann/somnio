import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { GENDER, TEMPO, headingFromCardinal } from '@somnio/core'
import type { Character, Gender, InventoryRow } from '@somnio/core'
import type { SomnioDatabase } from '../db.ts'
import { confusableSkeleton } from '../namePolicy/namePolicy.ts'
import type { Database } from '../schema.ts'
import { RepositoryDecodingError } from './errors.ts'
import { insertInventoryRows } from './inventoryRows.ts'

export interface CharacterRepository {
  create(accountId: string, name: string, figure: number, gender: Gender): Promise<Character>
  findByAccount(accountId: string): Promise<Character[]>
  findByName(name: string): Promise<Character | undefined>
  /**
   * Persists `character` over its row, skipped when the row's `last_seen` is already at or past
   * the snapshot's — another writer committed fresher state. Returns whether the update landed.
   */
  snapshot(character: Character): Promise<boolean>
  /**
   * Atomically persists the character and replaces its inventory rows in one transaction, gated
   * by the same `last_seen` skip-if-stale guard. Returns `false` (touching no inventory) when the
   * character update was skipped as stale.
   */
  persistCheckpoint(character: Character, inventory: readonly InventoryRow[]): Promise<boolean>
}

const STARTER_SECTOR = 'EdariaBibliothek'

const CHARACTER_COLUMNS = [
  'id',
  'name',
  'figure',
  'gender',
  'current_sector',
  'position_x',
  'position_y',
  'facing',
  'tempo',
  'hp_current',
  'hp_max',
  'balance_current',
  'balance_max',
  'mana_current',
  'mana_max',
  'last_seen',
] as const

type CharacterRow = {
  id: string
  name: string
  figure: number
  gender: number
  current_sector: string
  position_x: number
  position_y: number
  facing: number
  tempo: number
  hp_current: number
  hp_max: number
  balance_current: number
  balance_max: number
  mana_current: number
  mana_max: number
  last_seen: Date
}

/** Spawn defaults: the starter sector, default tempo, full energy, and the `(0, 0)` sentinel the runtime re-resolves. */
export function newCharacter(
  id: string,
  name: string,
  figure: number,
  gender: Gender,
  lastSeen: Date
): Character {
  return {
    id,
    name,
    figure,
    gender,
    currentSector: STARTER_SECTOR,
    position: { x: 0, y: 0 },
    facing: headingFromCardinal('south'),
    tempo: TEMPO.default,
    energy: {
      hpCurrent: 100,
      hpMax: 100,
      balanceCurrent: 100,
      balanceMax: 100,
      manaCurrent: 100,
      manaMax: 100,
    },
    lastSeen,
  }
}

function decodeCharacter(row: CharacterRow): Character {
  if (row.gender !== GENDER.male && row.gender !== GENDER.female) {
    throw new RepositoryDecodingError('gender', row.gender)
  }
  if (row.tempo !== TEMPO.walk && row.tempo !== TEMPO.default && row.tempo !== TEMPO.run) {
    throw new RepositoryDecodingError('tempo', row.tempo)
  }
  return {
    id: row.id,
    name: row.name,
    figure: row.figure,
    gender: row.gender,
    currentSector: row.current_sector,
    position: { x: row.position_x, y: row.position_y },
    facing: row.facing,
    tempo: row.tempo,
    energy: {
      hpCurrent: row.hp_current,
      hpMax: row.hp_max,
      balanceCurrent: row.balance_current,
      balanceMax: row.balance_max,
      manaCurrent: row.mana_current,
      manaMax: row.mana_max,
    },
    lastSeen: row.last_seen,
  }
}

function characterColumns(character: Character) {
  return {
    figure: character.figure,
    gender: character.gender,
    current_sector: character.currentSector,
    position_x: character.position.x,
    position_y: character.position.y,
    facing: character.facing,
    tempo: character.tempo,
    hp_current: character.energy.hpCurrent,
    hp_max: character.energy.hpMax,
    balance_current: character.energy.balanceCurrent,
    balance_max: character.energy.balanceMax,
    mana_current: character.energy.manaCurrent,
    mana_max: character.energy.manaMax,
    last_seen: character.lastSeen,
  }
}

export async function insertCharacter(
  db: Kysely<Database>,
  accountId: string,
  character: Character
): Promise<void> {
  await db
    .insertInto('characters')
    .values({
      id: character.id,
      account_id: accountId,
      name: character.name,
      ...characterColumns(character),
      name_skeleton: confusableSkeleton(character.name),
    })
    .execute()
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
    .execute()
  return updated.length > 0
}

export class PostgresCharacterRepository implements CharacterRepository {
  private readonly db: SomnioDatabase

  constructor(db: SomnioDatabase) {
    this.db = db
  }

  async create(accountId: string, name: string, figure: number, gender: Gender): Promise<Character> {
    const character = newCharacter(crypto.randomUUID(), name, figure, gender, new Date())
    await insertCharacter(this.db, accountId, character)
    return character
  }

  async findByAccount(accountId: string): Promise<Character[]> {
    const rows = await this.db
      .selectFrom('characters')
      .select(CHARACTER_COLUMNS)
      .where('account_id', '=', accountId)
      .orderBy('name')
      .execute()
    return rows.map(decodeCharacter)
  }

  /** NFKC-only lookup through `name_normalized`, like the account repository's. */
  async findByName(name: string): Promise<Character | undefined> {
    const row = await this.db
      .selectFrom('characters')
      .select(CHARACTER_COLUMNS)
      .where('name_normalized', '=', sql<string>`LOWER(NORMALIZE(${name}, NFKC))`)
      .executeTakeFirst()
    return row === undefined ? undefined : decodeCharacter(row)
  }

  snapshot(character: Character): Promise<boolean> {
    return guardedUpdate(this.db, character)
  }

  persistCheckpoint(character: Character, inventory: readonly InventoryRow[]): Promise<boolean> {
    return this.db.transaction().execute(async (transaction) => {
      if (!(await guardedUpdate(transaction, character))) return false
      await transaction.deleteFrom('inventory_rows').where('character_id', '=', character.id).execute()
      await insertInventoryRows(transaction, character.id, inventory)
      return true
    })
  }
}
