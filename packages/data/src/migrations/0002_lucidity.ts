import { sql } from 'kysely';
import type { Kysely } from 'kysely';

/**
 * What a character grows into: the role, the teaching studied, the task held, and one row per
 * teaching for its rank and the practice toward the next. Applied in place over existing
 * characters, who come out of it with no role and no ranks.
 *
 * The pools gain a floor: they fall in play now, and a negative one would read as fallen forever.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('characters')
    .addColumn('role', 'text')
    .addColumn('study', 'text')
    .addColumn('task_role', 'text')
    .addColumn('task_teaching', 'text')
    .addColumn('task_progress', 'double precision', (column) => column.notNull().defaultTo(0))
    .execute();
  await db.schema
    .alterTable('characters')
    .addCheckConstraint('characters_role_check', sql`role IS NULL OR role IN ('kaempfer', 'heiler')`)
    .execute();
  await db.schema
    .alterTable('characters')
    .addCheckConstraint('characters_health_floor_check', sql`health_current >= 0`)
    .execute();
  await db.schema
    .alterTable('characters')
    .addCheckConstraint('characters_balance_floor_check', sql`balance_current >= 0`)
    .execute();
  await db.schema
    .alterTable('characters')
    .addCheckConstraint('characters_spirit_floor_check', sql`spirit_current >= 0`)
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
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('character_ranks').execute();
  await db.schema.alterTable('characters').dropConstraint('characters_spirit_floor_check').execute();
  await db.schema.alterTable('characters').dropConstraint('characters_balance_floor_check').execute();
  await db.schema.alterTable('characters').dropConstraint('characters_health_floor_check').execute();
  await db.schema.alterTable('characters').dropConstraint('characters_role_check').execute();
  await db.schema
    .alterTable('characters')
    .dropColumn('task_progress')
    .dropColumn('task_teaching')
    .dropColumn('task_role')
    .dropColumn('study')
    .dropColumn('role')
    .execute();
}
