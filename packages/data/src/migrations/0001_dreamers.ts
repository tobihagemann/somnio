import { sql } from 'kysely';
import type { Kysely } from 'kysely';

/**
 * The schema every later migration builds on.
 *
 * An account is found by its email, so `email_normalized` is the UNIQUE-enforced column: case- and
 * NFKC-variants of one address cannot hold two accounts. A character's `name_normalized` does the
 * same for its name, and `name_skeleton` (computed by the name policy at insert) closes the
 * cross-script lookalike gap NFKC leaves open. The constraint names are load-bearing:
 * `accounts.ts` maps a 23505 on the accounts' key to `EmailTakenError`, and `characters.ts` one on
 * the characters' pair to `CharacterNameTakenError`.
 *
 * The pools have a floor: they fall in play, and a negative one would read as fallen forever.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('accounts')
    .addColumn('id', 'uuid', (column) => column.primaryKey())
    .addColumn('password_hash', 'text', (column) => column.notNull())
    .addColumn('email', 'text', (column) => column.notNull())
    .addColumn('email_normalized', 'text', (column) =>
      column
        .notNull()
        .generatedAlwaysAs(sql`LOWER(NORMALIZE(email, NFKC))`)
        .stored(),
    )
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`NOW()`))
    .addUniqueConstraint('accounts_email_normalized_key', ['email_normalized'])
    .execute();

  await db.schema
    .createTable('characters')
    .addColumn('id', 'uuid', (column) => column.primaryKey())
    .addColumn('account_id', 'uuid', (column) => column.notNull().references('accounts.id').onDelete('cascade'))
    .addColumn('name', 'text', (column) => column.notNull())
    .addColumn('name_normalized', 'text', (column) =>
      column
        .notNull()
        .generatedAlwaysAs(sql`LOWER(NORMALIZE(name, NFKC))`)
        .stored(),
    )
    .addColumn('people', 'text', (column) => column.notNull())
    .addColumn('space', 'text', (column) => column.notNull())
    .addColumn('position_x', 'double precision', (column) => column.notNull())
    .addColumn('position_z', 'double precision', (column) => column.notNull())
    .addColumn('facing', 'double precision', (column) => column.notNull())
    .addColumn('health_current', 'integer', (column) => column.notNull())
    .addColumn('health_max', 'integer', (column) => column.notNull())
    .addColumn('balance_current', 'integer', (column) => column.notNull())
    .addColumn('balance_max', 'integer', (column) => column.notNull())
    .addColumn('spirit_current', 'integer', (column) => column.notNull())
    .addColumn('spirit_max', 'integer', (column) => column.notNull())
    .addColumn('last_seen', 'timestamptz', (column) => column.notNull())
    .addColumn('name_skeleton', 'text', (column) => column.notNull())
    .addColumn('role', 'text')
    .addColumn('study', 'text')
    .addColumn('task_role', 'text')
    .addColumn('task_teaching', 'text')
    .addColumn('task_progress', 'double precision', (column) => column.notNull().defaultTo(0))
    .addCheckConstraint('characters_health_check', sql`health_current <= health_max`)
    .addCheckConstraint('characters_balance_check', sql`balance_current <= balance_max`)
    .addCheckConstraint('characters_spirit_check', sql`spirit_current <= spirit_max`)
    .addCheckConstraint('characters_health_floor_check', sql`health_current >= 0`)
    .addCheckConstraint('characters_balance_floor_check', sql`balance_current >= 0`)
    .addCheckConstraint('characters_spirit_floor_check', sql`spirit_current >= 0`)
    // `mystic` ahead of `ROLES`, so the Mystic role needs no constraint migration.
    .addCheckConstraint('characters_role_check', sql`role IS NULL OR role IN ('fighter', 'healer', 'mystic')`)
    .addUniqueConstraint('characters_name_normalized_key', ['name_normalized'])
    .addUniqueConstraint('characters_name_skeleton_key', ['name_skeleton'])
    .execute();

  await db.schema
    .createTable('character_ranks')
    .addColumn('character_id', 'uuid', (column) => column.notNull().references('characters.id').onDelete('cascade'))
    .addColumn('teaching_id', 'text', (column) => column.notNull())
    .addColumn('rank', 'integer', (column) => column.notNull())
    .addColumn('practice', 'double precision', (column) => column.notNull())
    .addPrimaryKeyConstraint('character_ranks_pkey', ['character_id', 'teaching_id'])
    .addCheckConstraint('character_ranks_rank_check', sql`rank >= 0`)
    .addCheckConstraint('character_ranks_practice_check', sql`practice >= 0`)
    .execute();

  await db.schema
    .createTable('inventory_rows')
    .addColumn('character_id', 'uuid', (column) => column.notNull().references('characters.id').onDelete('cascade'))
    .addColumn('slot', 'int2', (column) => column.notNull())
    .addColumn('item_id', 'text', (column) => column.notNull())
    .addColumn('quantity', 'integer', (column) => column.notNull())
    .addColumn('equipped_hand', 'text')
    .addPrimaryKeyConstraint('inventory_rows_pkey', ['character_id', 'slot'])
    .addCheckConstraint('inventory_rows_quantity_check', sql`quantity >= 0`)
    .addCheckConstraint('inventory_rows_equipped_hand_check', sql`equipped_hand IS NULL OR equipped_hand IN ('left', 'right')`)
    .execute();

  await db.schema
    .createTable('world_clock')
    .addColumn('id', 'boolean', (column) => column.primaryKey().defaultTo(true))
    .addColumn('world_seconds', 'double precision', (column) => column.notNull())
    .addCheckConstraint('world_clock_single_row', sql`id = TRUE`)
    .execute();

  await db.schema
    .createTable('npc_dialog_states')
    .addColumn('sector_name', 'text', (column) => column.notNull())
    .addColumn('npc_id', 'text', (column) => column.notNull())
    .addColumn('script_step', 'integer', (column) => column.notNull())
    .addPrimaryKeyConstraint('npc_dialog_states_pkey', ['sector_name', 'npc_id'])
    .execute();

  // The stored value is an unsalted SHA-256 digest of the raw token, never the token itself, so
  // a database read cannot be replayed as a credential; unsalted so the column is directly
  // searchable, which is safe because the token is 256 bits of CSPRNG output. The digest is the
  // primary key, so the lookup path and the uniqueness guarantee share one index.
  await db.schema
    .createTable('sessions')
    .addColumn('token_digest', 'text', (column) => column.primaryKey())
    .addColumn('account_id', 'uuid', (column) => column.notNull().references('accounts.id').onDelete('cascade'))
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`NOW()`))
    .addColumn('expires_at', 'timestamptz', (column) => column.notNull())
    .execute();
  // Redemption filters on expiry and cleanup deletes by it, so both paths want the index; the
  // account index serves the ON DELETE CASCADE and the per-account cap eviction.
  await db.schema.createIndex('sessions_expires_at_idx').on('sessions').column('expires_at').execute();
  await db.schema.createIndex('sessions_account_id_idx').on('sessions').column('account_id').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('sessions').execute();
  await db.schema.dropTable('npc_dialog_states').execute();
  await db.schema.dropTable('world_clock').execute();
  await db.schema.dropTable('inventory_rows').execute();
  await db.schema.dropTable('character_ranks').execute();
  await db.schema.dropTable('characters').execute();
  await db.schema.dropTable('accounts').execute();
}
