import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOOT_DEFAULT_WORLD_CLOCK } from '@somnio/core';
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
    expect(await clocks.load()).toEqual(BOOT_DEFAULT_WORLD_CLOCK);
  });

  it('preserves all six fields across save and load', async () => {
    const snapshot = { second: 42, minute: 17, hour: 23, day: 7, month: 4, year: 612 };
    await clocks.save(snapshot);
    expect(await clocks.load()).toEqual(snapshot);
  });

  it('updates the single row on a second save', async () => {
    await clocks.save({ second: 1, minute: 1, hour: 1, day: 1, month: 1, year: 500 });
    const updated = { second: 2, minute: 2, hour: 2, day: 2, month: 2, year: 501 };
    await clocks.save(updated);
    expect(await clocks.load()).toEqual(updated);
  });

  it('the single-row constraint refuses a second row', async () => {
    await clocks.save({ second: 1, minute: 1, hour: 1, day: 1, month: 1, year: 500 });
    await expect(
      sql`INSERT INTO world_clock (id, second, minute, hour, day, month, year) VALUES (false, 0, 0, 0, 1, 1, 1)`.execute(harness.db),
    ).rejects.toThrow();
  });
});
