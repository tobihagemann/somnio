import { sql } from 'kysely';
import type { Kysely } from 'kysely';

/** One `SELECT 1`; throws when the pool cannot serve a query. Boot lets that end the process, `/health` answers 503. */
export async function assertQueryable<DB>(db: Kysely<DB>): Promise<void> {
  await sql`SELECT 1`.execute(db);
}
