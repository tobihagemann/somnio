import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BOOT_DEFAULT_WORLD_CLOCK, SOMNIO_CONSTANTS } from '@somnio/core'
import { PostgresWorldClockRepository } from '@somnio/data'
import { WorldClockService } from '../../src/services/worldClockService.ts'
import { testLogger } from '../support/logger.ts'
import {
  bootTestServer,
  joinFreshPlayer,
  makeDatabaseDependencies,
  sleep,
  startDatabase,
} from './support/harness.ts'
import type { DatabaseHarness } from './support/harness.ts'

const SEED = { second: 50, minute: 11, hour: 12, day: 1, month: 1, year: 500 }

let harness: DatabaseHarness

beforeAll(async () => {
  harness = await startDatabase()
})
afterAll(async () => {
  await harness.stop()
})

describe('world clock persistence', () => {
  it('seeds from the deterministic boot tuple on first start and hands it to a joining client', async () => {
    const worldClocks = new PostgresWorldClockRepository(harness.db)
    expect(await worldClocks.load()).toEqual(BOOT_DEFAULT_WORLD_CLOCK)
    const server = await bootTestServer(harness.url, { worldClockIntervalMs: 60_000 })
    try {
      const joined = await joinFreshPlayer(server.url, 'seed')
      expect(joined.join.at(-1)).toEqual({ tag: 'dateTick', payload: { hour: 12, minute: 0 } })
      await joined.client.close()
    } finally {
      await server.stop()
    }
  })

  it('persists across a service restart', async () => {
    const worldClocks = new PostgresWorldClockRepository(harness.db)
    await worldClocks.save(SEED)
    const first = await bootTestServer(harness.url, { worldClockIntervalMs: 10 })
    await sleep(500)
    await first.stop()
    const persisted = await worldClocks.load()
    expect(persisted).not.toEqual(SEED)
    // Pre-loaded synchronously and handed in as the required initial clock, like the boot does.
    const dependencies = await makeDatabaseDependencies(harness.db)
    const service = new WorldClockService(
      dependencies.worldRouter,
      worldClocks,
      await worldClocks.load(),
      testLogger()
    )
    expect(service.currentTime()).toEqual(persisted)
    expect(service.currentTime()).not.toEqual(BOOT_DEFAULT_WORLD_CLOCK)
  })

  it('survives a full restart and is observed by a joining client', async () => {
    const worldClocks = new PostgresWorldClockRepository(harness.db)
    await worldClocks.save(SEED)
    const first = await bootTestServer(harness.url, { worldClockIntervalMs: 10 })
    await sleep(300)
    await first.stop()
    const persisted = await worldClocks.load()
    expect(persisted).not.toEqual(SEED)
    const second = await bootTestServer(harness.url, { worldClockIntervalMs: 60_000 })
    try {
      const joined = await joinFreshPlayer(second.url, 'survivor')
      const tick = joined.join.at(-1)
      expect(tick?.tag === 'dateTick' && tick.payload.hour).toBe(persisted.hour)
      await joined.client.close()
    } finally {
      await second.stop()
    }
  })

  it('dateTick frames emit at minute boundaries 12, 24, 36, 48 and the hour rollover', async () => {
    const worldClocks = new PostgresWorldClockRepository(harness.db)
    await worldClocks.save({ second: 55, minute: 11, hour: 12, day: 1, month: 1, year: 500 })
    const fast = await bootTestServer(harness.url, { worldClockIntervalMs: 1 })
    try {
      const joined = await joinFreshPlayer(fast.url, 'boundary')
      const minutes: number[] = []
      while (minutes.length < 5) {
        const { target } = await joined.client.until('dateTick', 30_000)
        if (target.tag === 'dateTick') minutes.push(target.payload.minute)
      }
      const cycle = [...SOMNIO_CONSTANTS.dateTickMinutes, 0]
      const start = cycle.indexOf(minutes[0]!)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(minutes).toEqual(cycle.map((_, index) => cycle[(start + index) % cycle.length]))
      await joined.client.close()
    } finally {
      await fast.stop()
    }
  })
})
