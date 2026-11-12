import { sql } from 'kysely';
import type { Kysely } from 'kysely';

/**
 * The single task becomes a quest log: each quest a character holds or turned in is a row, at its
 * place in the list of its state. A held quest carries what was done toward each objective in
 * `progress`, and a bounty its generated `definition`. The data is test data, so a live task is
 * dropped rather than converted, and the dreamer asks their master for it again. Roles and ranks
 * stay as they are.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('character_quests')
    .addColumn('character_id', 'uuid', (column) => column.notNull().references('characters.id').onDelete('cascade'))
    .addColumn('quest_id', 'text', (column) => column.notNull())
    .addColumn('state', 'text', (column) => column.notNull())
    .addColumn('place', 'int2', (column) => column.notNull())
    .addColumn('progress', 'jsonb')
    .addColumn('definition', 'jsonb')
    .addPrimaryKeyConstraint('character_quests_pkey', ['character_id', 'quest_id'])
    .addCheckConstraint('character_quests_state_check', sql`state IN ('active', 'done')`)
    .addCheckConstraint('character_quests_place_check', sql`place >= 0`)
    .addCheckConstraint('character_quests_progress_check', sql`(state = 'active') = (progress IS NOT NULL)`)
    .addUniqueConstraint('character_quests_character_id_state_place_key', ['character_id', 'state', 'place'])
    .execute();

  await db.schema.alterTable('characters').dropColumn('task_role').dropColumn('task_teaching').dropColumn('task_progress').execute();
}

/** Puts the task columns back, every character without a task, and drops the quest log. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('characters')
    .addColumn('task_role', 'text')
    .addColumn('task_teaching', 'text')
    .addColumn('task_progress', 'double precision', (column) => column.notNull().defaultTo(0))
    .execute();
  await db.schema.dropTable('character_quests').execute();
}
