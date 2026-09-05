import type { ColumnType, Generated } from 'kysely'

// The Postgres schema, as the migration creates it. `Generated<>` marks columns Postgres fills
// (defaults and the generated `name_normalized`), so inserts may omit them. Enum raws in SMALLINT
// columns: gender male 0 / female 1; hand left 0 / right 1; tempo walk 1 / default 2 / run 4;
// facing is REAL degrees, 0 = south, 90 = east.

export interface AccountsTable {
  id: string
  name: string
  name_normalized: Generated<string>
  password_hash: string
  email: string
  created_at: Generated<Date>
  name_skeleton: string
}

export interface CharactersTable {
  id: string
  account_id: string
  name: string
  name_normalized: Generated<string>
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
  name_skeleton: string
}

export interface InventoryRowsTable {
  character_id: string
  slot: number
  category: number
  item_id: number
  /**
   * A bare ordered JSON array of `{key, value}` — the array form preserves extra ordering. Written
   * as a JSON string: the driver would otherwise serialize a JS array as a Postgres array.
   */
  extras: ColumnType<{ key: string; value: number }[], string | undefined, string>
  equipped_hand: number | null
}

export interface WorldClockTable {
  id: Generated<boolean>
  second: number
  minute: number
  hour: number
  day: number
  month: number
  year: number
}

export interface NPCDialogStatesTable {
  sector_name: string
  npc_index: number
  script_step: number
}

export interface SessionsTable {
  token_digest: string
  account_id: string
  created_at: Generated<Date>
  expires_at: Date
}

export interface Database {
  accounts: AccountsTable
  characters: CharactersTable
  inventory_rows: InventoryRowsTable
  world_clock: WorldClockTable
  npc_dialog_states: NPCDialogStatesTable
  sessions: SessionsTable
}
