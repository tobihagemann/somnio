import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { newItemId } from '@somnio/core';

/**
 * What every character is given in place of their inventory rows, written out here rather than read
 * from the server's starter kit, so this migration keeps doing what it did whatever later changes
 * the kit: a plain tier-1 cudgel in the bag, and the item their role's trial gives in the off hand.
 */
const KIT: readonly { baseId: string; equippedSlot: string | null; bagPlace: number | null }[] = [{ baseId: 'cudgel', equippedSlot: null, bagPlace: 0 }];
const ROLE_ITEMS: Readonly<Record<string, string>> = { healer: 'moonstone', mystic: 'wand' };

/**
 * Items become instances of their own: a base, a tier, a rarity, and rolled affixes, worn in a slot
 * or carried at a place in the bag, one item per slot and per place. The purse becomes the characters'
 * `coins`, which keep what each purse held. The data is test data, so each character is given the kit
 * in place of their rows.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('characters')
    .addColumn('coins', 'integer', (column) => column.notNull().defaultTo(0))
    .execute();
  await db.schema
    .alterTable('characters')
    .addCheckConstraint('characters_coins_floor_check', sql`coins >= 0`)
    .execute();
  await sql`
    UPDATE characters SET coins = COALESCE((SELECT SUM(quantity) FROM inventory_rows WHERE character_id = characters.id AND item_id = 'purse'), 0)
  `.execute(db);
  await db.schema
    .alterTable('characters')
    .alterColumn('coins', (column) => column.dropDefault())
    .execute();

  await db.schema
    .createTable('items')
    .addColumn('id', 'uuid', (column) => column.primaryKey())
    .addColumn('character_id', 'uuid', (column) => column.notNull().references('characters.id').onDelete('cascade'))
    .addColumn('base_id', 'text', (column) => column.notNull())
    .addColumn('tier', 'int2', (column) => column.notNull())
    .addColumn('rarity', 'text', (column) => column.notNull())
    .addColumn('affixes', 'jsonb', (column) => column.notNull())
    .addColumn('equipped_slot', 'text')
    .addColumn('bag_place', 'int2')
    .addCheckConstraint('items_tier_check', sql`tier BETWEEN 1 AND 5`)
    .addCheckConstraint('items_rarity_check', sql`rarity IN ('plain', 'magic', 'rare')`)
    .addCheckConstraint(
      'items_equipped_slot_check',
      sql`equipped_slot IS NULL OR equipped_slot IN ('mainHand', 'offHand', 'head', 'chest', 'hands', 'legs', 'feet', 'neck', 'ring1', 'ring2')`,
    )
    .addCheckConstraint('items_bag_place_check', sql`bag_place BETWEEN 0 AND 23`)
    .addCheckConstraint('items_worn_or_bagged_check', sql`(equipped_slot IS NULL) <> (bag_place IS NULL)`)
    // NULLs are distinct, so these hold one item per worn slot and one per bag place, each counting
    // only the items it places. The first index leads with `character_id`, which serves loading a
    // character's items and the cascade.
    .addUniqueConstraint('items_character_id_equipped_slot_key', ['character_id', 'equipped_slot'])
    .addUniqueConstraint('items_character_id_bag_place_key', ['character_id', 'bag_place'])
    .execute();

  const characters = await sql<{ id: string; role: string | null }>`SELECT id, role FROM characters`.execute(db);
  for (const { id, role } of characters.rows) {
    const roleItem = role === null ? undefined : ROLE_ITEMS[role];
    const kit = roleItem === undefined ? KIT : [...KIT, { baseId: roleItem, equippedSlot: 'offHand', bagPlace: null }];
    for (const { baseId, equippedSlot, bagPlace } of kit) {
      await sql`
        INSERT INTO items (id, character_id, base_id, tier, rarity, affixes, equipped_slot, bag_place)
        VALUES (${newItemId()}, ${id}, ${baseId}, 1, 'plain', '[]', ${equippedSlot}, ${bagPlace})
      `.execute(db);
    }
  }

  await db.schema.dropTable('inventory_rows').execute();
}

/** Puts the purse and each item back as an inventory row, a hand item in its hand, and drops what rows cannot carry: the tier, the rarity, and the affixes. */
export async function down(db: Kysely<unknown>): Promise<void> {
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
  await sql`INSERT INTO inventory_rows (character_id, slot, item_id, quantity) SELECT id, 0, 'purse', coins FROM characters`.execute(db);
  await sql`
    INSERT INTO inventory_rows (character_id, slot, item_id, quantity, equipped_hand)
    SELECT character_id, ROW_NUMBER() OVER (PARTITION BY character_id ORDER BY id), base_id, 1,
      CASE equipped_slot WHEN 'mainHand' THEN 'right' WHEN 'offHand' THEN 'left' END
    FROM items
  `.execute(db);
  await db.schema.dropTable('items').execute();
  await db.schema.alterTable('characters').dropColumn('coins').execute();
}
