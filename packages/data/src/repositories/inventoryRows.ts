import type { Kysely } from 'kysely';
import type { InventoryRow } from '@somnio/core';
import type { Database } from '../schema.ts';
import { RepositoryDecodingError } from './errors.ts';

/** The `inventory_rows` insert and decode shared by the inventory, character, and registration repositories. */

type InventoryRowRecord = {
  slot: number;
  item_id: string;
  quantity: number;
  equipped_hand: string | null;
};

export function decodeInventoryRow(row: InventoryRowRecord): InventoryRow {
  return {
    slot: row.slot,
    itemId: row.item_id,
    quantity: row.quantity,
    equippedHand: decodeHand(row.equipped_hand),
  };
}

function decodeHand(raw: string | null): InventoryRow['equippedHand'] {
  if (raw === null) return undefined;
  if (raw === 'left' || raw === 'right') return raw;
  throw new RepositoryDecodingError('equipped_hand', raw);
}

/** An unequipped row's `equippedHand` is stored as SQL `NULL`. */
export async function insertInventoryRows(db: Kysely<Database>, characterId: string, rows: readonly InventoryRow[]): Promise<void> {
  for (const row of rows) {
    await db
      .insertInto('inventory_rows')
      .values({
        character_id: characterId,
        slot: row.slot,
        item_id: row.itemId,
        quantity: row.quantity,
        equipped_hand: row.equippedHand ?? null,
      })
      .execute();
  }
}
