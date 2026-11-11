import type { ColumnType, Generated } from 'kysely';

// The Postgres schema, as the migrations create it. `Generated<>` marks columns Postgres fills
// (defaults and the generated `*_normalized` columns), so inserts may omit them. Positions are metres
// in the character's space; facing is degrees, 0 = south, 90 = east.

export interface AccountsTable {
  id: string;
  password_hash: string;
  email: string;
  email_normalized: Generated<string>;
  created_at: Generated<Date>;
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
  role: string | null;
  study: string | null;
  /** Set while the character holds a task, with `task_teaching` null for the role's trial. */
  task_role: string | null;
  task_teaching: string | null;
  task_progress: number;
  coins: number;
}

export interface CharacterRanksTable {
  character_id: string;
  teaching_id: string;
  rank: number;
  practice: number;
}

/** One item a character has: worn in `equipped_slot`, or at `bag_place` in their bag, exactly one of the two set. */
export interface ItemsTable {
  id: string;
  character_id: string;
  base_id: string;
  tier: number;
  rarity: string;
  /** The rolled affixes as `[{affixId, value}]`: written as JSON text, read back parsed. */
  affixes: ColumnType<unknown, string, string>;
  equipped_slot: string | null;
  bag_place: number | null;
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
  character_ranks: CharacterRanksTable;
  items: ItemsTable;
  world_clock: WorldClockTable;
  npc_dialog_states: NPCDialogStatesTable;
  sessions: SessionsTable;
}
