import type { Kysely } from 'kysely';
import { HAND } from '@somnio/core';
import type { Hand, InventoryRow } from '@somnio/core';
import type { Database } from '../schema.ts';
import { RepositoryDecodingError } from './errors.ts';

/** The `inventory_rows` insert and decode shared by the inventory, character, and registration repositories. */

type InventoryRowRecord = {
  slot: number;
  category: number;
  item_id: number;
  extras: { key: string; value: number }[];
  equipped_hand: number | null;
};

export function decodeInventoryRow(row: InventoryRowRecord): InventoryRow {
  return {
    slot: row.slot,
    category: row.category,
    itemId: row.item_id,
    extras: row.extras.map((extra) => ({ key: extra.key, value: extra.value })),
    equippedHand: decodeHand(row.equipped_hand),
  };
}

function decodeHand(raw: number | null): Hand | undefined {
  if (raw === null) return undefined;
  if (raw === HAND.left || raw === HAND.right) return raw;
  throw new RepositoryDecodingError('equipped_hand', raw);
}

/** `undefined` ↔ SQL `NULL`; `extras` travels as a JSON array literal so the driver stores it as JSONB. */
export async function insertInventoryRows(db: Kysely<Database>, characterId: string, rows: readonly InventoryRow[]): Promise<void> {
  for (const row of rows) {
    await db
      .insertInto('inventory_rows')
      .values({
        character_id: characterId,
        slot: row.slot,
        category: row.category,
        item_id: row.itemId,
        extras: JSON.stringify(row.extras.map((extra) => ({ key: extra.key, value: extra.value }))),
        equipped_hand: row.equippedHand ?? null,
      })
      .execute();
  }
}
