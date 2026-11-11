import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { plain } from '../../../core/test/support/items.ts';
import { LegacyDatabaseError, MigrationError, migrateToLatest } from '../../src/migrate.ts';
import { down as dreamersDown, up as dreamersUp } from '../../src/migrations/0001_dreamers.ts';
import { PostgresItemRepository } from '../../src/repositories/items.ts';
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
      'character_ranks',
      'characters',
      'items',
      'kysely_migration',
      'kysely_migration_lock',
      'npc_dialog_states',
      'sessions',
      'world_clock',
    ]);
  });

  it('creates the named constraints, the skeleton column, and the session indexes', async () => {
    const constraints = await sql<{ constraint_name: string }>`
      SELECT constraint_name FROM information_schema.table_constraints
      WHERE table_name IN ('accounts', 'characters') AND constraint_type = 'UNIQUE'
      ORDER BY constraint_name
    `.execute(harness.db);
    expect(constraints.rows.map((row) => row.constraint_name)).toEqual([
      'accounts_email_normalized_key',
      'characters_name_normalized_key',
      'characters_name_skeleton_key',
    ]);
    const columns = await sql<{ column_name: string; is_nullable: string }>`
      SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'characters'
    `.execute(harness.db);
    expect(columns.rows.find((row) => row.column_name === 'name_skeleton')?.is_nullable).toBe('NO');
    const indexes = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'sessions' ORDER BY indexname
    `.execute(harness.db);
    expect(indexes.rows.map((row) => row.indexname)).toEqual(['sessions_account_id_idx', 'sessions_expires_at_idx', 'sessions_pkey']);
  });

  it('cascades sessions when their account is deleted', async () => {
    const accountId = crypto.randomUUID();
    await sql`INSERT INTO accounts (id, password_hash, email)
      VALUES (${accountId}, 'h', 'c@example.com')`.execute(harness.db);
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

  it.each(['0001_initial', '0001_metric_world'])('refuses an earlier TypeScript schema, recorded as %s, by naming the cutover', async (name) => {
    // Kysely's own bookkeeping table, carrying a migration this server no longer registers.
    await sql`CREATE TABLE IF NOT EXISTS kysely_migration (name VARCHAR(255) PRIMARY KEY, timestamp VARCHAR(255) NOT NULL)`.execute(harness.db);
    await sql`INSERT INTO kysely_migration (name, timestamp) VALUES (${name}, ${new Date().toISOString()})`.execute(harness.db);
    await expect(migrateToLatest(harness.db)).rejects.toThrow(LegacyDatabaseError);
    await sql`DELETE FROM kysely_migration WHERE name = ${name}`.execute(harness.db);
  });
});

describe('upgrading a database from the first schema', () => {
  let harness: DatabaseHarness;

  beforeAll(async () => {
    harness = await startDatabase({ migrate: false });
    const first = new Migrator({
      db: harness.db,
      provider: { getMigrations: () => Promise.resolve({ '0001_dreamers': { up: dreamersUp, down: dreamersDown } }) },
    });
    expect((await first.migrateToLatest()).error).toBeUndefined();
    const accountId = crypto.randomUUID();
    await sql`INSERT INTO accounts (id, password_hash, email) VALUES (${accountId}, 'h', 'old@example.com')`.execute(harness.db);
    for (const [name, role, coins] of [
      ['Hale', 'healer', 37],
      ['Myst', 'mystic', 250],
      ['Plain', null, null],
    ] as const) {
      const id = crypto.randomUUID();
      await sql`INSERT INTO characters (
        id, account_id, name, people, space, position_x, position_z, facing,
        health_current, health_max, balance_current, balance_max, spirit_current, spirit_max, last_seen, name_skeleton, role
      ) VALUES (
        ${id}, ${accountId}, ${name}, 'vigils', 'EdariaLibrary', 0, 0, 0, 100, 100, 100, 100, 100, 100, NOW(), ${name.toLowerCase()}, ${role}
      )`.execute(harness.db);
      if (coins !== null) {
        await sql`INSERT INTO inventory_rows (character_id, slot, item_id, quantity) VALUES (${id}, 0, 'purse', ${coins})`.execute(harness.db);
      }
      await sql`INSERT INTO inventory_rows (character_id, slot, item_id, quantity, equipped_hand) VALUES (${id}, 1, 'mace', 1, 'right')`.execute(harness.db);
    }
    await migrateToLatest(harness.db);
  });

  afterAll(async () => {
    await harness.stop();
  });

  async function inventoryOf(name: string) {
    const character = await sql<{ id: string }>`SELECT id FROM characters WHERE name = ${name}`.execute(harness.db);
    return new PostgresItemRepository(harness.db).load(character.rows[0]!.id);
  }

  it.each([
    ['a Healer their Moonstone', 'Hale', 37, { offHand: { id: expect.any(String), ...plain('moonstone') } }],
    ['a Mystic a plain focus', 'Myst', 250, { offHand: { id: expect.any(String), ...plain('wand') } }],
    ['a dreamer with no role nothing', 'Plain', 0, {}],
  ])('keeps the coins, gives the starter kit in place of the rows, and puts in hand for %s', async (_label, name, coins, equipped) => {
    expect(await inventoryOf(name)).toEqual({ coins, equipped, bag: [{ place: 0, item: { id: expect.any(String), ...plain('cudgel') } }] });
  });

  it('drops the inventory rows', async () => {
    const rows = await sql<{ exists: string | null }>`SELECT to_regclass('inventory_rows') AS exists`.execute(harness.db);
    expect(rows.rows[0]?.exists).toBeNull();
  });
});
