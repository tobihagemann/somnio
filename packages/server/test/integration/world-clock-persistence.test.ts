import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOOT_DEFAULT_WORLD_SECONDS, WORLD_TIME_RATE } from '@somnio/core';
import { PostgresWorldClockRepository } from '@somnio/data';
import { bootTestServer, joinFreshPlayer, sleep, startDatabase } from './support/harness.ts';
import type { DatabaseHarness, JoinedClient } from './support/harness.ts';

const SEED = 15_000_000_000.5;

let harness: DatabaseHarness;

beforeAll(async () => {
  harness = await startDatabase();
});
afterAll(async () => {
  await harness.stop();
});

function joinedWorldSeconds(joined: JoinedClient): number {
  const enter = joined.join[1];
  if (enter?.tag !== 'enterSpace') throw new Error('join carried no enterSpace');
  return enter.payload.worldSeconds;
}

describe('world clock persistence', () => {
  it('seeds from the deterministic boot default on first start and hands it to a joining client', async () => {
    const worldClocks = new PostgresWorldClockRepository(harness.db);
    expect(await worldClocks.load()).toBe(BOOT_DEFAULT_WORLD_SECONDS);
    // An interval this long never ticks, so the clock is still the default when the client joins.
    const server = await bootTestServer(harness.url, { worldClockIntervalMs: 60_000 });
    try {
      const joined = await joinFreshPlayer(server.url, 'seed');
      expect(joinedWorldSeconds(joined)).toBe(BOOT_DEFAULT_WORLD_SECONDS);
      await joined.client.close();
    } finally {
      await server.stop();
    }
  });

  it('advances at the world time rate and survives a full restart, observed by a joining client', async () => {
    const worldClocks = new PostgresWorldClockRepository(harness.db);
    await worldClocks.save(SEED);
    const first = await bootTestServer(harness.url, { worldClockIntervalMs: 10 });
    await sleep(500);
    await first.stop();
    const persisted = await worldClocks.load();
    // Half a second of wall time in 10 ms ticks, with slack for the boot and the shutdown on either side of it.
    expect(persisted).toBeGreaterThan(SEED + 0.25 * WORLD_TIME_RATE);
    expect(persisted).toBeLessThan(SEED + 30 * WORLD_TIME_RATE);
    const second = await bootTestServer(harness.url, { worldClockIntervalMs: 60_000 });
    try {
      const joined = await joinFreshPlayer(second.url, 'survivor');
      expect(joinedWorldSeconds(joined)).toBe(persisted);
      await joined.client.close();
    } finally {
      await second.stop();
    }
  });
});
