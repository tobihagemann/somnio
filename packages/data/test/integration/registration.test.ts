import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GENDER } from '@somnio/core'
import type { InventoryRow } from '@somnio/core'
import { PostgresAccountRepository } from '../../src/repositories/accounts.ts'
import { PostgresCharacterRepository } from '../../src/repositories/characters.ts'
import { PostgresInventoryRepository } from '../../src/repositories/inventory.ts'
import { PostgresRegistrationRepository, RegistrationError } from '../../src/repositories/registration.ts'
import { startDatabase } from './support/harness.ts'
import type { DatabaseHarness } from './support/harness.ts'

const STARTER_ROWS: InventoryRow[] = [
  { slot: 0, category: 0, itemId: 0, extras: [{ key: 'gold', value: 100 }], equippedHand: undefined },
  { slot: 1, category: 1, itemId: 0, extras: [], equippedHand: undefined },
]

describe('registration repository', () => {
  let harness: DatabaseHarness
  let registrations: PostgresRegistrationRepository
  let accounts: PostgresAccountRepository
  let characters: PostgresCharacterRepository
  let inventory: PostgresInventoryRepository

  const register = (name: string, passwordHash: string, starterInventory: InventoryRow[] = []) =>
    registrations.register({
      name,
      passwordHash,
      email: `${passwordHash}@example.com`,
      gender: GENDER.male,
      figure: 0,
      starterInventory,
    })

  beforeAll(async () => {
    harness = await startDatabase()
    registrations = new PostgresRegistrationRepository(harness.db)
    accounts = new PostgresAccountRepository(harness.db)
    characters = new PostgresCharacterRepository(harness.db)
    inventory = new PostgresInventoryRepository(harness.db)
  })

  afterAll(async () => {
    await harness.stop()
  })

  it('provisions the account, character, and starter inventory atomically', async () => {
    const { account, character } = await register('fighter-one', 'argon2-hash-stub', STARTER_ROWS)
    expect(account.name).toBe('fighter-one')
    expect(character.name).toBe('fighter-one')
    expect(character.currentSector).toBe('EdariaBibliothek')
    expect((await accounts.findByName('fighter-one'))?.id).toBe(account.id)
    expect(await characters.findByAccount(account.id)).toHaveLength(1)
    const stored = await inventory.loadAll(character.id)
    expect(stored).toHaveLength(STARTER_ROWS.length)
    expect(stored[0]?.extras.find((extra) => extra.key === 'gold')?.value).toBe(100)
  })

  it('surfaces a duplicate nickname as nicknameTaken', async () => {
    await register('alice', 'first')
    await expect(register('Alice', 'second')).rejects.toThrow(RegistrationError)
  })

  it('collides a confusable second registration on the skeleton constraint', async () => {
    await register('ADMIN', 'first')
    // All-Cyrillic "АDMIN" slips past `name_normalized`; the confusable skeleton catches it.
    await expect(register('АDMIN', 'second')).rejects.toThrow(
      expect.objectContaining({ kind: 'nicknameTaken' })
    )
  })

  it('stores the same NFKC base as the runtime computes', async () => {
    // Guards against ICU version skew between Node and postgres:16 — the two uniqueness layers
    // must agree on the normalized base. Full-width "Ｍｅｒｃｕｓ" exercises compatibility folding.
    const name = 'Ｍｅｒｃｕｓ'
    await register(name, 'nfkc')
    const stored = await sql<{
      name_normalized: string
    }>`SELECT name_normalized FROM accounts WHERE name = ${name}`.execute(harness.db)
    expect(stored.rows[0]?.name_normalized).toBe(name.normalize('NFKC').toLowerCase())
  })

  it('leaves no partial rows behind the loser of a duplicate race', async () => {
    await register('bob', 'winner')
    await expect(
      register('bob', 'loser', [{ slot: 99, category: 99, itemId: 99, extras: [], equippedHand: undefined }])
    ).rejects.toThrow(RegistrationError)
    const stored = await accounts.findByName('bob')
    expect(stored?.passwordHash).toBe('winner')
    expect(await characters.findByAccount(stored!.id)).toHaveLength(1)
  })
})
