import { sql } from 'kysely'
import type { Kysely } from 'kysely'

/**
 * The whole schema in one migration.
 *
 * `name_normalized` is the UNIQUE-enforced column so case- and NFKC-confusable collisions
 * ("Admin" vs "admin" vs full-width) cannot coexist; `name_skeleton` (computed by the name policy
 * at insert) closes the cross-script lookalike gap NFKC leaves open. The constraint names are
 * load-bearing: `registration.ts` maps a 23505 on any of the four to `nicknameTaken`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('accounts')
    .addColumn('id', 'uuid', (column) => column.primaryKey())
    .addColumn('name', 'text', (column) => column.notNull())
    .addColumn('name_normalized', 'text', (column) =>
      column
        .notNull()
        .generatedAlwaysAs(sql`LOWER(NORMALIZE(name, NFKC))`)
        .stored()
    )
    .addColumn('password_hash', 'text', (column) => column.notNull())
    .addColumn('email', 'text', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`NOW()`))
    .addColumn('name_skeleton', 'text', (column) => column.notNull())
    .addUniqueConstraint('accounts_name_normalized_key', ['name_normalized'])
    .addUniqueConstraint('accounts_name_skeleton_key', ['name_skeleton'])
    .execute()

  await db.schema
    .createTable('characters')
    .addColumn('id', 'uuid', (column) => column.primaryKey())
    .addColumn('account_id', 'uuid', (column) =>
      column.notNull().references('accounts.id').onDelete('cascade')
    )
    .addColumn('name', 'text', (column) => column.notNull())
    .addColumn('name_normalized', 'text', (column) =>
      column
        .notNull()
        .generatedAlwaysAs(sql`LOWER(NORMALIZE(name, NFKC))`)
        .stored()
    )
    .addColumn('figure', 'int2', (column) => column.notNull())
    .addColumn('gender', 'int2', (column) => column.notNull())
    .addColumn('current_sector', 'text', (column) => column.notNull())
    .addColumn('position_x', 'int2', (column) => column.notNull())
    .addColumn('position_y', 'int2', (column) => column.notNull())
    .addColumn('facing', 'real', (column) => column.notNull())
    .addColumn('tempo', 'int2', (column) => column.notNull())
    .addColumn('hp_current', 'int2', (column) => column.notNull())
    .addColumn('hp_max', 'int2', (column) => column.notNull())
    .addColumn('balance_current', 'int2', (column) => column.notNull())
    .addColumn('balance_max', 'int2', (column) => column.notNull())
    .addColumn('mana_current', 'int2', (column) => column.notNull())
    .addColumn('mana_max', 'int2', (column) => column.notNull())
    .addColumn('last_seen', 'timestamptz', (column) => column.notNull())
    .addColumn('name_skeleton', 'text', (column) => column.notNull())
    .addCheckConstraint('characters_hp_check', sql`hp_current <= hp_max`)
    .addCheckConstraint('characters_balance_check', sql`balance_current <= balance_max`)
    .addCheckConstraint('characters_mana_check', sql`mana_current <= mana_max`)
    .addUniqueConstraint('characters_name_normalized_key', ['name_normalized'])
    .addUniqueConstraint('characters_name_skeleton_key', ['name_skeleton'])
    .execute()

  await db.schema
    .createTable('inventory_rows')
    .addColumn('character_id', 'uuid', (column) =>
      column.notNull().references('characters.id').onDelete('cascade')
    )
    .addColumn('slot', 'int2', (column) => column.notNull())
    .addColumn('category', 'int2', (column) => column.notNull())
    .addColumn('item_id', 'int2', (column) => column.notNull())
    .addColumn('extras', 'jsonb', (column) => column.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('equipped_hand', 'int2')
    .addPrimaryKeyConstraint('inventory_rows_pkey', ['character_id', 'slot'])
    .addCheckConstraint(
      'inventory_rows_equipped_hand_check',
      sql`equipped_hand IS NULL OR equipped_hand IN (0, 1)`
    )
    .execute()

  await db.schema
    .createTable('world_clock')
    .addColumn('id', 'boolean', (column) => column.primaryKey().defaultTo(true))
    .addColumn('second', 'int2', (column) => column.notNull())
    .addColumn('minute', 'int2', (column) => column.notNull())
    .addColumn('hour', 'int2', (column) => column.notNull())
    .addColumn('day', 'int2', (column) => column.notNull())
    .addColumn('month', 'int2', (column) => column.notNull())
    .addColumn('year', 'int2', (column) => column.notNull())
    .addCheckConstraint('world_clock_single_row', sql`id = TRUE`)
    .execute()

  await db.schema
    .createTable('npc_dialog_states')
    .addColumn('sector_name', 'text', (column) => column.notNull())
    .addColumn('npc_index', 'int2', (column) => column.notNull())
    .addColumn('script_step', 'int2', (column) => column.notNull())
    .addPrimaryKeyConstraint('npc_dialog_states_pkey', ['sector_name', 'npc_index'])
    .execute()

  // The stored value is an unsalted SHA-256 digest of the raw token, never the token itself, so
  // a database read cannot be replayed as a credential; unsalted so the column is directly
  // searchable, which is safe because the token is 256 bits of CSPRNG output. The digest is the
  // primary key, so the lookup path and the uniqueness guarantee share one index.
  await db.schema
    .createTable('sessions')
    .addColumn('token_digest', 'text', (column) => column.primaryKey())
    .addColumn('account_id', 'uuid', (column) =>
      column.notNull().references('accounts.id').onDelete('cascade')
    )
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`NOW()`))
    .addColumn('expires_at', 'timestamptz', (column) => column.notNull())
    .execute()
  // Redemption filters on expiry and cleanup deletes by it, so both paths want the index; the
  // account index serves the ON DELETE CASCADE and the per-account cap eviction.
  await db.schema.createIndex('sessions_expires_at_idx').on('sessions').column('expires_at').execute()
  await db.schema.createIndex('sessions_account_id_idx').on('sessions').column('account_id').execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('sessions').execute()
  await db.schema.dropTable('npc_dialog_states').execute()
  await db.schema.dropTable('world_clock').execute()
  await db.schema.dropTable('inventory_rows').execute()
  await db.schema.dropTable('characters').execute()
  await db.schema.dropTable('accounts').execute()
}
