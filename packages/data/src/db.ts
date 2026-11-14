import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { PostgresConfiguration } from './postgresConfig.ts';
import type { Database } from './schema.ts';

export type SomnioDatabase = Kysely<Database>;

/**
 * How long the pool waits on Postgres. `statementMs` and `idleInTransactionMs` go to the server as
 * startup parameters: Postgres cancels a statement past `statementMs` and rolls its transaction
 * back, and ends the session of a transaction left idle past `idleInTransactionMs`. `connectMs`
 * bounds a new connection and the wait for a pooled one. `queryMs` is pg's client-side backstop for
 * a query with no answer at all, longer than the statement limit so Postgres aborts first.
 *
 * `queryMs` neither cancels the query nor discards the connection. Outside a transaction the
 * connection goes back to the pool still waiting on it, so each later query on it fails the same
 * way until its socket errors. Inside one, the rollback waits too before Kysely discards the
 * connection.
 */
export interface DatabaseTimeouts {
  statementMs: number;
  idleInTransactionMs: number;
  connectMs: number;
  queryMs: number;
}

const DEFAULT_TIMEOUTS: DatabaseTimeouts = { statementMs: 5000, idleInTransactionMs: 10_000, connectMs: 5000, queryMs: 10_000 };

/**
 * `onPoolError` receives the first error each pooled client raises as an event, idle or checked
 * out: a backend restart, a dropped link, Postgres ending a transaction left idle. Left unhandled,
 * one would take the whole process down. The pool listens only while a client is idle, so each
 * client gets a listener of its own. The pool also re-emits what it hears from an idle client,
 * which needs the pool's own listener, a no-op since the client has already reported it. A query in
 * flight rejects with the error, a later one as not queryable, and the pool discards the client
 * once it is released.
 */
export function createDatabase(
  configuration: PostgresConfiguration,
  onPoolError: (error: Error) => void = () => {},
  timeouts: Partial<DatabaseTimeouts> = {},
): SomnioDatabase {
  const { statementMs, idleInTransactionMs, connectMs, queryMs } = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const pool = new pg.Pool({
    host: configuration.host,
    port: configuration.port,
    user: configuration.user,
    password: configuration.password,
    database: configuration.database,
    ssl: configuration.ssl,
    statement_timeout: statementMs,
    idle_in_transaction_session_timeout: idleInTransactionMs,
    connectionTimeoutMillis: connectMs,
    query_timeout: queryMs,
  });
  pool.on('connect', (client) => {
    // A connection that breaks raises its cause, then pg's own "Connection terminated" once the socket ends: only the cause is news.
    let reported = false;
    client.on('error', (error) => {
      if (reported) return;
      reported = true;
      onPoolError(error);
    });
  });
  pool.on('error', () => {});
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
