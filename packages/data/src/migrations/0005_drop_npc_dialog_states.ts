import type { Kysely } from 'kysely';

/** Drops each NPC's saved place in its dialog, so after a restart a conversation starts at its first step. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('npc_dialog_states').execute();
}

/** Puts the table back empty, as the first schema made it. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('npc_dialog_states')
    .addColumn('sector_name', 'text', (column) => column.notNull())
    .addColumn('npc_id', 'text', (column) => column.notNull())
    .addColumn('script_step', 'integer', (column) => column.notNull())
    .addPrimaryKeyConstraint('npc_dialog_states_pkey', ['sector_name', 'npc_id'])
    .execute();
}
