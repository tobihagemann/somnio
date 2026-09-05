export interface PostgresConfiguration {
  host: string
  port: number
  user: string
  password: string | undefined
  database: string
  /** `false` disables TLS; otherwise the connection verifies the server certificate. */
  ssl: false | { rejectUnauthorized: true }
}

export type PostgresConfigurationErrorKind = 'invalidDatabaseURL' | 'missingDatabaseURL'

export class PostgresConfigurationError extends Error {
  readonly kind: PostgresConfigurationErrorKind

  constructor(kind: PostgresConfigurationErrorKind, message: string) {
    super(message)
    this.name = 'PostgresConfigurationError'
    this.kind = kind
  }
}

const DEFAULT_PORT = 5432
const DEFAULT_USER = 'postgres'
const DEFAULT_DATABASE = 'somnio'
/** The `somnio-pg` dev container: `postgres://postgres:postgres@localhost:17663/somnio`, TLS off. */
const DEV_CONTAINER: PostgresConfiguration = {
  host: 'localhost',
  port: 17663,
  user: DEFAULT_USER,
  password: 'postgres',
  database: DEFAULT_DATABASE,
  ssl: false,
}

/**
 * Postgres connection settings resolved from the environment.
 *
 * `SOMNIO_DATABASE_URL` is authoritative when present: `postgres` or `postgresql` scheme, and
 * the URL's port, user, password, and path as the database name, defaulting to 5432, `postgres`,
 * no password, and `somnio` where a component is absent. TLS is required unless
 * `SOMNIO_DATABASE_TLS=disable`, so a network attacker cannot strip it. With no URL, the
 * dev-defaults opt-in yields a plaintext connection to the `somnio-pg` dev container
 * (`postgres://postgres:postgres@localhost:17663/somnio`); without the opt-in the server refuses
 * to boot rather than silently connecting to whatever Postgres the operator happens to run.
 */
export function resolvePostgresConfiguration(
  env: Record<string, string | undefined>,
  devDefaults: boolean
): PostgresConfiguration {
  const raw = env['SOMNIO_DATABASE_URL']
  if (raw !== undefined) {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new PostgresConfigurationError(
        'invalidDatabaseURL',
        `SOMNIO_DATABASE_URL is malformed: ${redact(raw)}`
      )
    }
    if ((url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') || url.hostname.length === 0) {
      throw new PostgresConfigurationError(
        'invalidDatabaseURL',
        `SOMNIO_DATABASE_URL is malformed: ${redact(raw)}`
      )
    }
    const pathDatabase = url.pathname.replace(/^\/+|\/+$/g, '')
    return {
      host: url.hostname,
      port: url.port.length === 0 ? DEFAULT_PORT : Number(url.port),
      user: url.username.length === 0 ? DEFAULT_USER : decodeURIComponent(url.username),
      password: url.password.length === 0 ? undefined : decodeURIComponent(url.password),
      database: pathDatabase.length === 0 ? DEFAULT_DATABASE : pathDatabase,
      ssl: env['SOMNIO_DATABASE_TLS'] === 'disable' ? false : { rejectUnauthorized: true },
    }
  }
  if (!devDefaults) {
    throw new PostgresConfigurationError(
      'missingDatabaseURL',
      'SOMNIO_DATABASE_URL must be set (or opt into SOMNIO_DEV_DEFAULTS=1 for the localhost fallback)'
    )
  }
  return DEV_CONTAINER
}

/**
 * Strips userinfo and path from a Postgres URL so a parse-failure message never leaks embedded
 * credentials: `postgres://user:pass@db.example.com:5432/somnio` → `postgres://db.example.com:5432`.
 */
export function redact(raw: string): string {
  try {
    const url = new URL(raw)
    if (url.hostname.length === 0) return '<unparseable>'
    const scheme = url.protocol.replace(/:$/, '')
    return url.port.length === 0 ? `${scheme}://${url.hostname}` : `${scheme}://${url.hostname}:${url.port}`
  } catch {
    return '<unparseable>'
  }
}
