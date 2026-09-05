import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { Migrator } from 'kysely/migration'
import type { Migration, MigrationProvider } from 'kysely/migration'
import { down as initialDown, up as initialUp } from './migrations/0001_initial.ts'

/** The migration list, in order. In memory rather than a filesystem walk: nothing compiles the tree. */
const MIGRATIONS: Record<string, Migration> = {
  '0001_initial': { up: initialUp, down: initialDown },
}

const provider: MigrationProvider = {
  getMigrations: () => Promise.resolve(MIGRATIONS),
}

/**
 * The database still carries the Swift-era schema (its `schema_migrations` table), which the
 * initial migration cannot be applied over; such a database has to be dropped and recreated.
 */
export class LegacyDatabaseError extends Error {
  constructor() {
    super(
      'the database still carries the Swift-era schema; this server needs a fresh database ' +
        '(locally: `docker compose down -v`; in production: drop and recreate the database)'
    )
    this.name = 'LegacyDatabaseError'
  }
}

export class MigrationError extends Error {
  readonly migrationName: string | undefined

  constructor(migrationName: string | undefined, cause: unknown) {
    super(`migration ${migrationName ?? '<unknown>'} failed: ${String(cause)}`, { cause })
    this.name = 'MigrationError'
    this.migrationName = migrationName
  }
}

/**
 * Applies every pending migration. A failure of the initial migration on a database that still
 * has the old bookkeeping table is reported as the cutover step rather than as a bare
 * "relation already exists" — the migration's own `CREATE TABLE` failure, rolled back in
 * Kysely's transaction, is what refuses the Swift-era database.
 */
export async function migrateToLatest<DB>(db: Kysely<DB>): Promise<void> {
  const migrator = new Migrator({ db, provider })
  const { error, results } = await migrator.migrateToLatest()
  if (error === undefined) return
  const failed = results?.find((result) => result.status === 'Error')?.migrationName
  if (failed === '0001_initial' && (await hasLegacySchema(db))) {
    throw new LegacyDatabaseError()
  }
  throw new MigrationError(failed, error)
}

async function hasLegacySchema<DB>(db: Kysely<DB>): Promise<boolean> {
  const result = await sql<{
    legacy: string | null
  }>`SELECT to_regclass('schema_migrations') AS legacy`.execute(db)
  return result.rows[0]?.legacy !== null && result.rows[0]?.legacy !== undefined
}
