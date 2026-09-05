import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { createDatabase } from '../../../src/db.ts'
import type { SomnioDatabase } from '../../../src/db.ts'
import { migrateToLatest } from '../../../src/migrate.ts'
import { resolvePostgresConfiguration } from '../../../src/postgresConfig.ts'

export interface DatabaseHarness {
  db: SomnioDatabase
  url: string
  /** Opens a second, independent connection to the same database. */
  connect(): SomnioDatabase
  stop(): Promise<void>
}

/**
 * One throwaway `postgres:16` per test file on tmpfs, migrated unless the caller opts out. Runs
 * only under the integration project, which needs Docker or Podman.
 */
export async function startDatabase(options: { migrate?: boolean } = {}): Promise<DatabaseHarness> {
  const container = await new PostgreSqlContainer('postgres:16')
    .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
    .start()
  const url = container.getConnectionUri()
  const opened: SomnioDatabase[] = []
  const connect = (): SomnioDatabase => {
    const db = createDatabase(
      resolvePostgresConfiguration({ SOMNIO_DATABASE_URL: url, SOMNIO_DATABASE_TLS: 'disable' }, false)
    )
    opened.push(db)
    return db
  }
  const db = connect()
  if (options.migrate !== false) await migrateToLatest(db)
  return {
    db,
    url,
    connect,
    stop: async () => {
      for (const connection of opened) await connection.destroy()
      await container.stop()
    },
  }
}
