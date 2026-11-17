import { sql } from 'kysely';
import type { Kysely } from 'kysely';

/**
 * Libus's errand grows from two objectives to five. A held errand keeps its counts toward the first
 * two and starts the new ones at nothing. Five is written here rather than read from the quest table,
 * so this migration keeps doing what it did whatever the errand later becomes.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE character_quests SET progress = jsonb_path_query_array(progress || '[0, 0, 0, 0, 0]', '$[0 to 4]')
    WHERE quest_id = 'newcomer-errand' AND state = 'active'
  `.execute(db);
}

/** Cuts a held errand back to its first two counts. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE character_quests SET progress = jsonb_path_query_array(progress, '$[0 to 1]')
    WHERE quest_id = 'newcomer-errand' AND state = 'active'
  `.execute(db);
}
