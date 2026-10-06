import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import type { Migration, MigrationProvider } from 'kysely/migration';
import { down as metricWorldDown, up as metricWorldUp } from './migrations/0001_metric_world.ts';
import { down as lucidityDown, up as lucidityUp } from './migrations/0002_lucidity.ts';

/** The migration list, in order. In memory rather than a filesystem walk: nothing compiles the tree. */
const MIGRATIONS: Record<string, Migration> = {
  '0001_metric_world': { up: metricWorldUp, down: metricWorldDown },
  '0002_lucidity': { up: lucidityUp, down: lucidityDown },
};

const provider: MigrationProvider = {
  getMigrations: () => Promise.resolve(MIGRATIONS),
};

/**
 * The database still carries an earlier schema, either the Swift-era one (its `schema_migrations`
 * table) or the previous TypeScript one (a `0001_initial` migration row), which the first migration
 * cannot be applied over; such a database has to be dropped and recreated.
 */
export class LegacyDatabaseError extends Error {
  constructor() {
    super(
      'the database still carries an earlier schema; this server needs a fresh database ' +
        '(locally: `docker compose down -v`; in production: drop and recreate the database)',
    );
    this.name = 'LegacyDatabaseError';
  }
}

export class MigrationError extends Error {
  readonly migrationName: string | undefined;

  constructor(migrationName: string | undefined, cause: unknown) {
    super(`migration ${migrationName ?? '<unknown>'} failed: ${String(cause)}`, { cause });
    this.name = 'MigrationError';
    this.migrationName = migrationName;
  }
}

/**
 * Applies every pending migration. A database that carries an earlier schema is reported as the
 * cutover step rather than as the bare failure it causes. The Swift-era one fails the first
 * migration's own `CREATE TABLE`, rolled back in Kysely's transaction. The previous TypeScript one is refused
 * by Kysely before any migration runs, as an error with no failed result, because its executed
 * migration is no longer registered.
 */
export async function migrateToLatest<DB>(db: Kysely<DB>): Promise<void> {
  const migrator = new Migrator({ db, provider });
  const { error, results } = await migrator.migrateToLatest();
  if (error === undefined) return;
  const failed = results?.find((result) => result.status === 'Error')?.migrationName;
  if ((failed === undefined || failed === '0001_metric_world') && (await hasLegacySchema(db))) {
    throw new LegacyDatabaseError();
  }
  throw new MigrationError(failed, error);
}

async function hasLegacySchema<DB>(db: Kysely<DB>): Promise<boolean> {
  const tables = await sql<{ swift: boolean; kysely: boolean }>`
    SELECT to_regclass('schema_migrations') IS NOT NULL AS swift, to_regclass('kysely_migration') IS NOT NULL AS kysely
  `.execute(db);
  if (tables.rows[0]?.swift === true) return true;
  if (tables.rows[0]?.kysely !== true) return false;
  const previous = await sql`SELECT 1 FROM kysely_migration WHERE name = '0001_initial'`.execute(db);
  return previous.rows.length > 0;
}
