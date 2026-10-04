import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { LegacyDatabaseError } from '@somnio/data';
import { bootTestServer, startDatabase } from './support/harness.ts';
import type { DatabaseHarness } from './support/harness.ts';

let harness: DatabaseHarness;

beforeAll(async () => {
  harness = await startDatabase();
});
afterAll(async () => {
  await harness.stop();
});

/** The whole boot, not just the guard: an empty sector directory must refuse rather than serve an empty world. */
it('refuses to boot over a sector directory with no sector files', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'somnio-no-sectors-'));
  try {
    await expect(bootTestServer(harness.url, { sectorsDirectory: empty })).rejects.toThrow(/no sectors loaded/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

/** A database the previous version migrated carries its migration row; the fresh schema cannot be applied over it. */
it('refuses to boot over a database the previous schema migrated', async () => {
  const legacy = await startDatabase({ migrate: false });
  try {
    await legacy.db.schema
      .createTable('kysely_migration')
      .addColumn('name', 'varchar(255)', (column) => column.primaryKey())
      .addColumn('timestamp', 'varchar(255)', (column) => column.notNull())
      .execute();
    await legacy.db
      .$extendTables<{ kysely_migration: { name: string; timestamp: string } }>()
      .insertInto('kysely_migration')
      .values({ name: '0001_initial', timestamp: new Date().toISOString() })
      .execute();
    await expect(bootTestServer(legacy.url)).rejects.toThrow(LegacyDatabaseError);
  } finally {
    await legacy.stop();
  }
});
