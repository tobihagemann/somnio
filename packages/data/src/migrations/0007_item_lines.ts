import { sql } from 'kysely';
import type { Kysely } from 'kysely';

/**
 * The rarities take their new names, plain becoming common and magic uncommon, and epic joins them.
 * An item gains the line of the role whose set it is a piece of, set exactly on an epic, so every
 * existing item keeps no line. The rarities and roles are written here rather than read from their
 * lists, so this migration keeps doing what it did whatever they later become.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('items').dropConstraint('items_rarity_check').execute();
  await sql`UPDATE items SET rarity = 'common' WHERE rarity = 'plain'`.execute(db);
  await sql`UPDATE items SET rarity = 'uncommon' WHERE rarity = 'magic'`.execute(db);
  await db.schema
    .alterTable('items')
    .addCheckConstraint('items_rarity_check', sql`rarity IN ('common', 'uncommon', 'rare', 'epic')`)
    .execute();
  await db.schema.alterTable('items').addColumn('line', 'text').execute();
  await db.schema
    .alterTable('items')
    .addCheckConstraint('items_line_check', sql`line IN ('fighter', 'healer', 'mystic')`)
    .execute();
  await db.schema
    .alterTable('items')
    .addCheckConstraint('items_line_epic_check', sql`(line IS NULL) = (rarity <> 'epic')`)
    .execute();
}

/** Gives the rarities their old names back and drops the line. An epic has no rarity there, so a database holding one fails the old check. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('items').dropConstraint('items_line_epic_check').execute();
  await db.schema.alterTable('items').dropConstraint('items_line_check').execute();
  await db.schema.alterTable('items').dropConstraint('items_rarity_check').execute();
  await sql`UPDATE items SET rarity = 'plain' WHERE rarity = 'common'`.execute(db);
  await sql`UPDATE items SET rarity = 'magic' WHERE rarity = 'uncommon'`.execute(db);
  await db.schema
    .alterTable('items')
    .addCheckConstraint('items_rarity_check', sql`rarity IN ('plain', 'magic', 'rare')`)
    .execute();
  await db.schema.alterTable('items').dropColumn('line').execute();
}
