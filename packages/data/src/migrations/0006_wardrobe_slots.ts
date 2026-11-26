import { sql } from 'kysely';
import type { Kysely } from 'kysely';

/**
 * The ring becomes the bracelet it is drawn as, worn in the two wrist slots, and a Shoulders slot
 * joins them. Every ring keeps its place and its rolls. The slots are written here rather than read
 * from the slot list, so this migration keeps doing what it did whatever the slots later become.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('items').dropConstraint('items_equipped_slot_check').execute();
  await sql`UPDATE items SET base_id = 'bracelet' WHERE base_id = 'ring'`.execute(db);
  await sql`
    UPDATE items SET equipped_slot = CASE equipped_slot WHEN 'ring1' THEN 'bracelet1' ELSE 'bracelet2' END
    WHERE equipped_slot IN ('ring1', 'ring2')
  `.execute(db);
  await db.schema
    .alterTable('items')
    .addCheckConstraint(
      'items_equipped_slot_check',
      sql`equipped_slot IS NULL OR equipped_slot IN ('mainHand', 'offHand', 'head', 'shoulders', 'chest', 'hands', 'legs', 'feet', 'neck', 'bracelet1', 'bracelet2')`,
    )
    .execute();
}

/** Turns the bracelets back into rings in the ring slots. Shoulders worn have no slot there, so they refuse the old check. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('items').dropConstraint('items_equipped_slot_check').execute();
  await sql`UPDATE items SET base_id = 'ring' WHERE base_id = 'bracelet'`.execute(db);
  await sql`
    UPDATE items SET equipped_slot = CASE equipped_slot WHEN 'bracelet1' THEN 'ring1' ELSE 'ring2' END
    WHERE equipped_slot IN ('bracelet1', 'bracelet2')
  `.execute(db);
  await db.schema
    .alterTable('items')
    .addCheckConstraint(
      'items_equipped_slot_check',
      sql`equipped_slot IS NULL OR equipped_slot IN ('mainHand', 'offHand', 'head', 'chest', 'hands', 'legs', 'feet', 'neck', 'ring1', 'ring2')`,
    )
    .execute();
}
