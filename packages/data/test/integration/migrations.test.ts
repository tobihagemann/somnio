import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LegacyDatabaseError, MigrationError, migrateToLatest } from '../../src/migrate.ts';
import { startDatabase } from './support/harness.ts';
import type { DatabaseHarness } from './support/harness.ts';

describe('migrations', () => {
  let harness: DatabaseHarness;

  beforeAll(async () => {
    harness = await startDatabase({ migrate: false });
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('applies the schema and is idempotent on a migrated database', async () => {
    await migrateToLatest(harness.db);
    await migrateToLatest(harness.db);
    const tables = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name
    `.execute(harness.db);
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'accounts',
      'characters',
      'inventory_rows',
      'kysely_migration',
      'kysely_migration_lock',
      'npc_dialog_states',
      'sessions',
      'world_clock',
    ]);
  });

  it('creates the named constraints and drops the skeleton version column', async () => {
    const constraints = await sql<{ constraint_name: string }>`
      SELECT constraint_name FROM information_schema.table_constraints
      WHERE table_name IN ('accounts', 'characters') AND constraint_type = 'UNIQUE'
      ORDER BY constraint_name
    `.execute(harness.db);
    expect(constraints.rows.map((row) => row.constraint_name)).toEqual([
      'accounts_name_normalized_key',
      'accounts_name_skeleton_key',
      'characters_name_normalized_key',
      'characters_name_skeleton_key',
    ]);
    const columns = await sql<{ column_name: string; is_nullable: string }>`
      SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'accounts'
    `.execute(harness.db);
    expect(columns.rows.find((row) => row.column_name === 'name_skeleton')?.is_nullable).toBe('NO');
    expect(columns.rows.some((row) => row.column_name === 'name_skeleton_version')).toBe(false);
    const indexes = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'sessions' ORDER BY indexname
    `.execute(harness.db);
    expect(indexes.rows.map((row) => row.indexname)).toEqual(['sessions_account_id_idx', 'sessions_expires_at_idx', 'sessions_pkey']);
  });

  it('cascades sessions when their account is deleted', async () => {
    const accountId = crypto.randomUUID();
    await sql`INSERT INTO accounts (id, name, password_hash, email, name_skeleton)
      VALUES (${accountId}, 'cascade-user', 'h', 'c@example.com', 'cascade-user')`.execute(harness.db);
    await sql`INSERT INTO sessions (token_digest, account_id, expires_at)
      VALUES ('deadbeef', ${accountId}, NOW() + INTERVAL '30 days')`.execute(harness.db);
    await sql`DELETE FROM accounts WHERE id = ${accountId}`.execute(harness.db);
    const remaining = await sql<{
      count: string;
    }>`SELECT COUNT(*) AS count FROM sessions WHERE account_id = ${accountId}`.execute(harness.db);
    expect(Number(remaining.rows[0]?.count)).toBe(0);
  });
});

describe('migrating a database that is not fresh', () => {
  let harness: DatabaseHarness;

  beforeAll(async () => {
    harness = await startDatabase({ migrate: false });
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('refuses the Swift-era schema by naming the cutover', async () => {
    await sql`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)`.execute(harness.db);
    await sql`CREATE TABLE accounts (id UUID PRIMARY KEY)`.execute(harness.db);
    await expect(migrateToLatest(harness.db)).rejects.toThrow(LegacyDatabaseError);
    // The failed migration rolled back: `characters` does not exist.
    const characters = await sql<{
      exists: string | null;
    }>`SELECT to_regclass('characters') AS exists`.execute(harness.db);
    expect(characters.rows[0]?.exists).toBeNull();
  });

  it('reports any other failure as a migration error', async () => {
    await sql`DROP TABLE schema_migrations`.execute(harness.db);
    await expect(migrateToLatest(harness.db)).rejects.toThrow(MigrationError);
  });
});
