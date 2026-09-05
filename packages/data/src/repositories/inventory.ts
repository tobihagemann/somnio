import type { InventoryRow } from '@somnio/core';
import type { SomnioDatabase } from '../db.ts';
import { decodeInventoryRow, insertInventoryRows } from './inventoryRows.ts';

export interface InventoryRepository {
  loadAll(characterId: string): Promise<InventoryRow[]>;
  replaceAll(characterId: string, rows: readonly InventoryRow[]): Promise<void>;
}

export class PostgresInventoryRepository implements InventoryRepository {
  private readonly db: SomnioDatabase;

  constructor(db: SomnioDatabase) {
    this.db = db;
  }

  async loadAll(characterId: string): Promise<InventoryRow[]> {
    const rows = await this.db
      .selectFrom('inventory_rows')
      .select(['slot', 'category', 'item_id', 'extras', 'equipped_hand'])
      .where('character_id', '=', characterId)
      .orderBy('slot')
      .execute();
    return rows.map(decodeInventoryRow);
  }

  async replaceAll(characterId: string, rows: readonly InventoryRow[]): Promise<void> {
    await this.db.transaction().execute(async (transaction) => {
      await transaction.deleteFrom('inventory_rows').where('character_id', '=', characterId).execute();
      await insertInventoryRows(transaction, characterId, rows);
    });
  }
}
