import { describe, expect, it } from 'vitest'
import { PostgresConfigurationError, redact, resolvePostgresConfiguration } from '../src/postgresConfig.ts'

describe('postgres configuration', () => {
  it('falls back to the plaintext dev container under dev defaults', () => {
    expect(resolvePostgresConfiguration({}, true)).toEqual({
      host: 'localhost',
      port: 17663,
      user: 'postgres',
      password: 'postgres',
      database: 'somnio',
      ssl: false,
    })
  })

  it('refuses to run without a URL outside dev defaults', () => {
    expect(() => resolvePostgresConfiguration({}, false)).toThrow(
      expect.objectContaining({ kind: 'missingDatabaseURL' })
    )
  })

  it('takes every field from the URL and requires TLS', () => {
    expect(
      resolvePostgresConfiguration(
        { SOMNIO_DATABASE_URL: 'postgres://alice:hunter2@db.example.com:6432/somnio' },
        false
      )
    ).toEqual({
      host: 'db.example.com',
      port: 6432,
      user: 'alice',
      password: 'hunter2',
      database: 'somnio',
      ssl: { rejectUnauthorized: true },
    })
  })

  it('falls back to the default database name on an empty path', () => {
    expect(
      resolvePostgresConfiguration({ SOMNIO_DATABASE_URL: 'postgres://alice@db.example.com:6432/' }, true)
        .database
    ).toBe('somnio')
    expect(
      resolvePostgresConfiguration({ SOMNIO_DATABASE_URL: 'postgres://alice@db.example.com:6432/' }, false)
        .database
    ).toBe('somnio')
  })

  it('defaults the port and user when the URL omits them', () => {
    const configuration = resolvePostgresConfiguration(
      { SOMNIO_DATABASE_URL: 'postgres://db.example.com/somnio' },
      false
    )
    expect(configuration.port).toBe(5432)
    expect(configuration.user).toBe('postgres')
    expect(configuration.password).toBeUndefined()
  })

  it('decodes a percent-encoded password', () => {
    // RFC 3986 requires `@` in a password to be percent-encoded as `%40`; the decoded form must
    // reach the driver verbatim or auth fails silently.
    expect(
      resolvePostgresConfiguration(
        { SOMNIO_DATABASE_URL: 'postgres://alice:p%40ss@db.example.com/somnio' },
        false
      ).password
    ).toBe('p@ss')
  })

  it('opts the URL out of TLS on SOMNIO_DATABASE_TLS=disable', () => {
    expect(
      resolvePostgresConfiguration(
        { SOMNIO_DATABASE_URL: 'postgres://alice@db.example.com/somnio', SOMNIO_DATABASE_TLS: 'disable' },
        true
      ).ssl
    ).toBe(false)
  })

  it('rejects a non-postgres scheme', () => {
    expect(() =>
      resolvePostgresConfiguration({ SOMNIO_DATABASE_URL: 'https://db.example.com/somnio' }, false)
    ).toThrow(PostgresConfigurationError)
  })

  it('accepts the postgresql scheme', () => {
    expect(
      resolvePostgresConfiguration({ SOMNIO_DATABASE_URL: 'postgresql://db.example.com/somnio' }, false).host
    ).toBe('db.example.com')
  })

  it('rejects a non-URL string', () => {
    expect(() => resolvePostgresConfiguration({ SOMNIO_DATABASE_URL: 'not a url' }, false)).toThrow(
      expect.objectContaining({ kind: 'invalidDatabaseURL' })
    )
  })

  it('redacts credentials and the path from a URL', () => {
    expect(redact('postgres://user:pass@db.example.com:5432/somnio')).toBe('postgres://db.example.com:5432')
    expect(redact('postgres://user:pass@db.example.com/somnio')).toBe('postgres://db.example.com')
    expect(redact('not a url')).toBe('<unparseable>')
  })
})
