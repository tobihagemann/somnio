import { sql } from 'kysely';
import type { Kysely } from 'kysely';

/**
 * The world's words in English: the roles, the peoples, the Healer's stone, and the library, the one
 * renamed sector a character's `space` can name (the renamed outdoor sectors all lie in `outdoors`). Applied in place, so every character keeps its role, its people,
 * its place, and what it carries. NPC dialog cursors stay keyed by sector name, so the NPCs of a
 * renamed sector, and any NPC moved to another sector, start their scripts over.
 */
const ROLES = [
  ['kaempfer', 'fighter'],
  ['heiler', 'healer'],
] as const;
const PEOPLES = [
  ['wachen', 'vigils'],
  ['soporen', 'sopors'],
  ['umbren', 'umbrae'],
] as const;
const SPACES = [['EdariaBibliothek', 'EdariaLibrary']] as const;
const ITEMS = [['mondstein', 'moonstone']] as const;

async function rename(db: Kysely<unknown>, from: 0 | 1): Promise<void> {
  const to = from === 0 ? 1 : 0;
  for (const pair of ROLES) {
    await sql`UPDATE characters SET role = ${pair[to]} WHERE role = ${pair[from]}`.execute(db);
    await sql`UPDATE characters SET task_role = ${pair[to]} WHERE task_role = ${pair[from]}`.execute(db);
  }
  for (const pair of PEOPLES) await sql`UPDATE characters SET people = ${pair[to]} WHERE people = ${pair[from]}`.execute(db);
  for (const pair of SPACES) await sql`UPDATE characters SET space = ${pair[to]} WHERE space = ${pair[from]}`.execute(db);
  for (const pair of ITEMS) await sql`UPDATE inventory_rows SET item_id = ${pair[to]} WHERE item_id = ${pair[from]}`.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('characters').dropConstraint('characters_role_check').execute();
  await rename(db, 0);
  await db.schema
    .alterTable('characters')
    .addCheckConstraint('characters_role_check', sql`role IS NULL OR role IN ('fighter', 'healer')`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('characters').dropConstraint('characters_role_check').execute();
  await rename(db, 1);
  await db.schema
    .alterTable('characters')
    .addCheckConstraint('characters_role_check', sql`role IS NULL OR role IN ('kaempfer', 'heiler')`)
    .execute();
}
