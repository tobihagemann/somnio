import { afterAll, beforeAll, expect, it } from 'vitest'
import { headingFromCardinal } from '@somnio/core'
import {
  PostgresCharacterRepository,
  PostgresInventoryRepository,
  PostgresRegistrationRepository,
  hashPassword,
} from '@somnio/data'
import { ConnectionOutbox } from '../../src/connection/outbox.ts'
import { STARTER_INVENTORY } from '../../src/handlers/starterInventory.ts'
import { TEST_PASSWORD, makeDatabaseDependencies, startDatabase, uniqueNickname } from './support/harness.ts'
import type { DatabaseHarness } from './support/harness.ts'

let harness: DatabaseHarness

beforeAll(async () => {
  harness = await startDatabase()
})
afterAll(async () => {
  await harness.stop()
})

it("checkpointAll persists every logged-in player's full character and inventory", async () => {
  const dependencies = await makeDatabaseDependencies(harness.db)
  const name = uniqueNickname('checkpoint')
  const { character } = await new PostgresRegistrationRepository(harness.db).register({
    name,
    passwordHash: await hashPassword(TEST_PASSWORD),
    email: `${name}@example.invalid`,
    gender: 0,
    figure: 0,
    starterInventory: STARTER_INVENTORY,
  })
  const sector = dependencies.worldRouter.sector('EdariaBibliothek')!
  const staged = {
    ...character,
    position: { x: 7, y: 11 },
    facing: headingFromCardinal('north'),
    energy: { ...character.energy, hpCurrent: 42 },
  }
  sector.attach(staged, [...STARTER_INVENTORY], new ConnectionOutbox(1024))

  await dependencies.worldRouter.checkpointAll()

  const reloaded = (await new PostgresCharacterRepository(harness.db).findByName(name))!
  expect(reloaded.position).toEqual({ x: 7, y: 11 })
  expect(reloaded.facing).toBe(headingFromCardinal('north'))
  expect(reloaded.energy.hpCurrent).toBe(42)
  const inventory = await new PostgresInventoryRepository(harness.db).loadAll(character.id)
  expect(inventory.length).toBe(STARTER_INVENTORY.length)
})
