import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOOT_DEFAULT_WORLD_SECONDS } from '@somnio/core';
import { PostgresWorldClockRepository } from '../../src/repositories/worldClock.ts';
import { startDatabase } from './support/harness.ts';
import type { DatabaseHarness } from './support/harness.ts';

describe('world clock repository', () => {
  let harness: DatabaseHarness;
  let clocks: PostgresWorldClockRepository;

  beforeAll(async () => {
    harness = await startDatabase();
    clocks = new PostgresWorldClockRepository(harness.db);
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('returns the boot default from an empty table', async () => {
    expect(await clocks.load()).toBe(BOOT_DEFAULT_WORLD_SECONDS);
  });

  it('preserves a fractional second near year 500 across save and load', async () => {
    const worldSeconds = BOOT_DEFAULT_WORLD_SECONDS + 0.25;
    await clocks.save(worldSeconds);
    expect(await clocks.load()).toBe(worldSeconds);
  });

  it('updates the single row on a second save', async () => {
    await clocks.save(BOOT_DEFAULT_WORLD_SECONDS);
    await clocks.save(BOOT_DEFAULT_WORLD_SECONDS + 60);
    expect(await clocks.load()).toBe(BOOT_DEFAULT_WORLD_SECONDS + 60);
  });

  it('the single-row constraint refuses a second row', async () => {
    await clocks.save(BOOT_DEFAULT_WORLD_SECONDS);
    await expect(sql`INSERT INTO world_clock (id, world_seconds) VALUES (false, 0)`.execute(harness.db)).rejects.toThrow();
  });
});
