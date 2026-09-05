import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { PostgresConfiguration } from './postgresConfig.ts'
import type { Database } from './schema.ts'

export type SomnioDatabase = Kysely<Database>

/**
 * `onPoolError` receives errors on idle pooled clients (a backend restart, a dropped link). The
 * pool emits them as events; left unhandled, one such event would take the whole process down.
 */
export function createDatabase(
  configuration: PostgresConfiguration,
  onPoolError: (error: Error) => void = () => {}
): SomnioDatabase {
  const pool = new pg.Pool({
    host: configuration.host,
    port: configuration.port,
    user: configuration.user,
    password: configuration.password,
    database: configuration.database,
    ssl: configuration.ssl,
  })
  pool.on('error', onPoolError)
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
}
