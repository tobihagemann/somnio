import type { Generated } from 'kysely';

// The Postgres schema, as the migration creates it. `Generated<>` marks columns Postgres fills
// (defaults and the generated `name_normalized`), so inserts may omit them. Positions are metres
// in the character's space; facing is degrees, 0 = south, 90 = east.

export interface AccountsTable {
  id: string;
  name: string;
  name_normalized: Generated<string>;
  password_hash: string;
  email: string;
  created_at: Generated<Date>;
  name_skeleton: string;
}

export interface CharactersTable {
  id: string;
  account_id: string;
  name: string;
  name_normalized: Generated<string>;
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
  name_skeleton: string;
}

export interface InventoryRowsTable {
  character_id: string;
  slot: number;
  item_id: string;
  quantity: number;
  equipped_hand: string | null;
}

export interface WorldClockTable {
  id: Generated<boolean>;
  world_seconds: number;
}

export interface NPCDialogStatesTable {
  sector_name: string;
  npc_id: string;
  script_step: number;
}

export interface SessionsTable {
  token_digest: string;
  account_id: string;
  created_at: Generated<Date>;
  expires_at: Date;
}

export interface Database {
  accounts: AccountsTable;
  characters: CharactersTable;
  inventory_rows: InventoryRowsTable;
  world_clock: WorldClockTable;
  npc_dialog_states: NPCDialogStatesTable;
  sessions: SessionsTable;
}
