import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GENDER, HAND } from '@somnio/core'
import type { InventoryRow } from '@somnio/core'
import { PostgresAccountRepository } from '../../src/repositories/accounts.ts'
import { PostgresCharacterRepository } from '../../src/repositories/characters.ts'
import { RepositoryDecodingError } from '../../src/repositories/errors.ts'
import { PostgresInventoryRepository } from '../../src/repositories/inventory.ts'
import { startDatabase } from './support/harness.ts'
import type { DatabaseHarness } from './support/harness.ts'

describe('inventory repository', () => {
  let harness: DatabaseHarness
  let accounts: PostgresAccountRepository
  let characters: PostgresCharacterRepository
  let inventory: PostgresInventoryRepository
  let counter = 0

  async function newCharacterId(): Promise<string> {
    counter += 1
    const account = await accounts.create(`inv-owner-${counter}`, 'h', `${counter}@example.com`)
    return (await characters.create(account.id, `Inv ${counter}`, 0, GENDER.female)).id
  }

  beforeAll(async () => {
    harness = await startDatabase()
    accounts = new PostgresAccountRepository(harness.db)
    characters = new PostgresCharacterRepository(harness.db)
    inventory = new PostgresInventoryRepository(harness.db)
  })

  afterAll(async () => {
    await harness.stop()
  })

  it('preserves rows and ordered extras across replaceAll and loadAll', async () => {
    const characterId = await newCharacterId()
    const purse: InventoryRow = {
      slot: 0,
      category: 0,
      itemId: 0,
      extras: [
        { key: 'gold', value: 100 },
        { key: 'silver', value: 5 },
      ],
      equippedHand: undefined,
    }
    const cudgel: InventoryRow = { slot: 1, category: 1, itemId: 0, extras: [], equippedHand: HAND.right }
    await inventory.replaceAll(characterId, [purse, cudgel])
    const loaded = await inventory.loadAll(characterId)
    expect(loaded).toEqual([purse, cudgel])
    expect(loaded[0]?.extras.map((extra) => extra.key)).toEqual(['gold', 'silver'])
  })

  it('round-trips left, right, and unequipped hands', async () => {
    const characterId = await newCharacterId()
    await inventory.replaceAll(characterId, [
      { slot: 0, category: 1, itemId: 0, extras: [], equippedHand: HAND.left },
      { slot: 1, category: 1, itemId: 0, extras: [], equippedHand: HAND.right },
      { slot: 2, category: 1, itemId: 0, extras: [], equippedHand: undefined },
    ])
    expect((await inventory.loadAll(characterId)).map((row) => row.equippedHand)).toEqual([
      HAND.left,
      HAND.right,
      undefined,
    ])
  })

  it('rolls replaceAll back when a row in the batch fails', async () => {
    const characterId = await newCharacterId()
    const initial: InventoryRow[] = [
      { slot: 0, category: 0, itemId: 0, extras: [{ key: 'gold', value: 100 }], equippedHand: undefined },
    ]
    await inventory.replaceAll(characterId, initial)
    // Two rows with the same slot violate the (character_id, slot) primary key; the transaction
    // must roll back the leading DELETE so the original row survives.
    await expect(
      inventory.replaceAll(characterId, [
        { slot: 0, category: 1, itemId: 0, extras: [], equippedHand: undefined },
        { slot: 0, category: 2, itemId: 1, extras: [], equippedHand: undefined },
      ])
    ).rejects.toThrow()
    expect(await inventory.loadAll(characterId)).toEqual(initial)
  })

  it('throws on an out-of-range equipped_hand', async () => {
    const characterId = await newCharacterId()
    await sql`ALTER TABLE inventory_rows DROP CONSTRAINT inventory_rows_equipped_hand_check`.execute(
      harness.db
    )
    await sql`INSERT INTO inventory_rows (character_id, slot, category, item_id, extras, equipped_hand)
      VALUES (${characterId}, 0, 1, 0, '[]'::jsonb, 5)`.execute(harness.db)
    await expect(inventory.loadAll(characterId)).rejects.toThrow(RepositoryDecodingError)
  })

  it('clears existing rows on an empty replaceAll', async () => {
    const characterId = await newCharacterId()
    await inventory.replaceAll(characterId, [
      { slot: 0, category: 0, itemId: 0, extras: [], equippedHand: undefined },
    ])
    await inventory.replaceAll(characterId, [])
    expect(await inventory.loadAll(characterId)).toEqual([])
  })
})
