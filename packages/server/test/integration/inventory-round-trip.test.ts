import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WIRE_HAND } from '@somnio/protocol'
import type { WireInventoryRow } from '@somnio/protocol'
import { HAND, goldBalance } from '@somnio/core'
import { PostgresCharacterRepository, PostgresInventoryRepository } from '@somnio/data'
import { STARTER_INVENTORY } from '../../src/handlers/starterInventory.ts'
import {
  bootTestServer,
  closeAndAwaitCleanup,
  frame,
  joinFreshPlayer,
  loginOverWire,
  pollUntil,
  startDatabase,
} from './support/harness.ts'
import type { DatabaseHarness, JoinedClient, TestServer } from './support/harness.ts'

let harness: DatabaseHarness
let server: TestServer

beforeAll(async () => {
  harness = await startDatabase()
  server = await bootTestServer(harness.url)
})
afterAll(async () => {
  await server.stop()
  await harness.stop()
})

function inventoryRows(joined: JoinedClient): WireInventoryRow[] {
  const inventory = joined.join.find((message) => message.tag === 'inventory')
  if (inventory?.tag !== 'inventory') throw new Error('join carried no inventory')
  return inventory.payload.rows
}

async function persistedCudgelHand(nickname: string) {
  const character = await new PostgresCharacterRepository(harness.db).findByName(nickname)
  const rows = await new PostgresInventoryRepository(harness.db).loadAll(character!.id)
  return rows.find((row) => row.slot === 1)!.equippedHand
}

describe('inventory round trip', () => {
  it('register then login surfaces the starter inventory in the inventory frame', async () => {
    const joined = await joinFreshPlayer(server.url, 'starter')
    const rows = inventoryRows(joined)
    expect(rows.length).toBe(STARTER_INVENTORY.length)
    const purse = rows.find((row) => row.slot === 0)!
    expect(purse.category).toBe(0)
    expect(purse.extras).toContainEqual({ key: 'gold', value: 100 })
    expect(goldBalance(STARTER_INVENTORY[0]!)).toBe(100)
    const cudgel = rows.find((row) => row.slot === 1)!
    expect(cudgel).toMatchObject({ category: 1, itemId: 0, equippedHand: WIRE_HAND.none })
    await joined.client.close()
  })

  it('equipToggle on the cudgel marks the equipped hand and re-emits the inventory', async () => {
    const joined = await joinFreshPlayer(server.url, 'equipper')
    joined.client.send(frame({ tag: 'equipToggle', payload: { slot: 1, hand: WIRE_HAND.right } }))
    const { target } = await joined.client.until('inventory')
    const cudgel = target.tag === 'inventory' ? target.payload.rows.find((row) => row.slot === 1) : undefined
    expect(cudgel?.equippedHand).toBe(WIRE_HAND.right)
    await joined.client.close()
  })

  it('equipping a second row to the same hand unequips the first', async () => {
    const joined = await joinFreshPlayer(server.url, 'twohanded')
    joined.client.send(frame({ tag: 'equipToggle', payload: { slot: 0, hand: WIRE_HAND.right } }))
    const first = await joined.client.until('inventory')
    expect(
      first.target.tag === 'inventory'
        ? first.target.payload.rows.find((row) => row.slot === 0)?.equippedHand
        : undefined
    ).toBe(WIRE_HAND.right)
    joined.client.send(frame({ tag: 'equipToggle', payload: { slot: 1, hand: WIRE_HAND.right } }))
    const second = await joined.client.until('inventory')
    const rows = second.target.tag === 'inventory' ? second.target.payload.rows : []
    expect(rows.find((row) => row.slot === 1)?.equippedHand).toBe(WIRE_HAND.right)
    expect(rows.find((row) => row.slot === 0)?.equippedHand).toBe(WIRE_HAND.none)
    await joined.client.close()
  })

  it('equip state is persisted by the close checkpoint and surfaces on reconnect', async () => {
    const joined = await joinFreshPlayer(server.url, 'persister')
    joined.client.send(frame({ tag: 'equipToggle', payload: { slot: 1, hand: WIRE_HAND.right } }))
    await joined.client.until('inventory')
    await closeAndAwaitCleanup(joined, server)
    expect(
      await pollUntil(async () =>
        (await persistedCudgelHand(joined.nickname)) === HAND.right ? true : undefined
      )
    ).toBe(true)

    const second = await loginOverWire(server.url, joined.nickname)
    expect(inventoryRows(second).find((row) => row.slot === 1)?.equippedHand).toBe(WIRE_HAND.right)
    second.client.send(frame({ tag: 'equipToggle', payload: { slot: 1, hand: WIRE_HAND.none } }))
    await second.client.until('inventory')
    await closeAndAwaitCleanup(second, server)
    expect(
      await pollUntil(async () =>
        (await persistedCudgelHand(joined.nickname)) === undefined ? true : undefined
      )
    ).toBe(true)

    const third = await loginOverWire(server.url, joined.nickname)
    expect(inventoryRows(third).find((row) => row.slot === 1)?.equippedHand).toBe(WIRE_HAND.none)
    await third.client.close()
  })
})
