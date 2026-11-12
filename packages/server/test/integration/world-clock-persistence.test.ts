import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOOT_DEFAULT_WORLD_SECONDS, WORLD_TIME_RATE, bountyLands, dayBounties, worldDay } from '@somnio/core';
import { PostgresWorldClockRepository } from '@somnio/data';
import { bootTestServer, joinFreshPlayer, sleep, startDatabase } from './support/harness.ts';
import type { DatabaseHarness, JoinedClient } from './support/harness.ts';

const SEED = 15_000_000_000.5;
const SECONDS_PER_DAY = 24 * 60 * 60;

let harness: DatabaseHarness;

beforeAll(async () => {
  harness = await startDatabase();
});
afterAll(async () => {
  await harness.stop();
});

function joinedWorldSeconds(joined: JoinedClient): number {
  const enter = joined.join.find((message) => message.tag === 'enterSpace');
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

  it('turns the bounty board over for a dreamer in the world as a tick carries the clock into a new day', async () => {
    const day = worldDay(SEED) + 1;
    const worldClocks = new PostgresWorldClockRepository(harness.db);
    // A world millisecond before the day turns, which the first tick after the join carries it past
    // however fast the join is, since the clock reads only as of its last tick.
    await worldClocks.save(day * SECONDS_PER_DAY - 0.001);
    // An interval this long never ticks on its own, so the test ticks the clock itself.
    const server = await bootTestServer(harness.url, { worldClockIntervalMs: 60_000 });
    try {
      const offered = (on: number) => dayBounties(on, bountyLands([...server.server.worldRouter.world.spaces.values()].flatMap((space) => space.sectors)));
      const joined = await joinFreshPlayer(server.url, 'daybreak');
      const quests = joined.join.find((message) => message.tag === 'quests');
      expect(quests?.tag === 'quests' ? quests.payload.bounties : undefined).toEqual(offered(day - 1));
      await server.server.worldClock.tickOnce();
      expect(worldDay(server.server.worldClock.currentWorldSeconds())).toBe(day);
      const { target } = await joined.client.until('quests');
      expect(target).toEqual({ tag: 'quests', payload: { active: [], done: [], bounties: offered(day) } });
      await joined.client.close();
    } finally {
      await server.stop();
    }
  });
});
