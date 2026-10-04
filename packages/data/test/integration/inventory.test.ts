import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InventoryRow } from '@somnio/core';
import { PostgresAccountRepository } from '../../src/repositories/accounts.ts';
import { PostgresCharacterRepository } from '../../src/repositories/characters.ts';
import { RepositoryDecodingError } from '../../src/repositories/errors.ts';
import { PostgresInventoryRepository } from '../../src/repositories/inventory.ts';
import { startDatabase } from './support/harness.ts';
import type { DatabaseHarness } from './support/harness.ts';

describe('inventory repository', () => {
  let harness: DatabaseHarness;
  let accounts: PostgresAccountRepository;
  let characters: PostgresCharacterRepository;
  let inventory: PostgresInventoryRepository;
  let counter = 0;

  async function newCharacterId(): Promise<string> {
    counter += 1;
    const account = await accounts.create(`inv-owner-${counter}`, 'h', `${counter}@example.com`);
    return (await characters.create(account.id, `Inv ${counter}`, 'wachen')).id;
  }

  beforeAll(async () => {
    harness = await startDatabase();
    accounts = new PostgresAccountRepository(harness.db);
    characters = new PostgresCharacterRepository(harness.db);
    inventory = new PostgresInventoryRepository(harness.db);
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('preserves rows across replaceAll and loadAll', async () => {
    const characterId = await newCharacterId();
    const purse: InventoryRow = { slot: 0, itemId: 'purse', quantity: 100, equippedHand: undefined };
    const cudgel: InventoryRow = { slot: 1, itemId: 'cudgel', quantity: 1, equippedHand: 'right' };
    await inventory.replaceAll(characterId, [purse, cudgel]);
    expect(await inventory.loadAll(characterId)).toEqual([purse, cudgel]);
  });

  it('round-trips left, right, and unequipped hands', async () => {
    const characterId = await newCharacterId();
    await inventory.replaceAll(characterId, [
      { slot: 0, itemId: 'cudgel', quantity: 1, equippedHand: 'left' },
      { slot: 1, itemId: 'cudgel', quantity: 1, equippedHand: 'right' },
      { slot: 2, itemId: 'cudgel', quantity: 1, equippedHand: undefined },
    ]);
    expect((await inventory.loadAll(characterId)).map((row) => row.equippedHand)).toEqual(['left', 'right', undefined]);
  });

  it('rolls replaceAll back when a row in the batch fails', async () => {
    const characterId = await newCharacterId();
    const initial: InventoryRow[] = [{ slot: 0, itemId: 'purse', quantity: 100, equippedHand: undefined }];
    await inventory.replaceAll(characterId, initial);
    // Two rows with the same slot violate the (character_id, slot) primary key; the transaction
    // must roll back the leading DELETE so the original row survives.
    await expect(
      inventory.replaceAll(characterId, [
        { slot: 0, itemId: 'cudgel', quantity: 1, equippedHand: undefined },
        { slot: 0, itemId: 'purse', quantity: 5, equippedHand: undefined },
      ]),
    ).rejects.toThrow();
    expect(await inventory.loadAll(characterId)).toEqual(initial);
  });

  it('refuses a negative quantity through the CHECK constraint', async () => {
    const characterId = await newCharacterId();
    await expect(inventory.replaceAll(characterId, [{ slot: 0, itemId: 'purse', quantity: -1, equippedHand: undefined }])).rejects.toThrow();
  });

  it('throws on an unknown equipped_hand', async () => {
    const characterId = await newCharacterId();
    await sql`ALTER TABLE inventory_rows DROP CONSTRAINT inventory_rows_equipped_hand_check`.execute(harness.db);
    await sql`INSERT INTO inventory_rows (character_id, slot, item_id, quantity, equipped_hand)
      VALUES (${characterId}, 0, 'cudgel', 1, 'both')`.execute(harness.db);
    await expect(inventory.loadAll(characterId)).rejects.toThrow(RepositoryDecodingError);
  });

  it('clears existing rows on an empty replaceAll', async () => {
    const characterId = await newCharacterId();
    await inventory.replaceAll(characterId, [{ slot: 0, itemId: 'purse', quantity: 0, equippedHand: undefined }]);
    await inventory.replaceAll(characterId, []);
    expect(await inventory.loadAll(characterId)).toEqual([]);
  });
});
