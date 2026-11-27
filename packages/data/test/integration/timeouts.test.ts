import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { commonInstance } from '@somnio/core';
import type { Character, Inventory } from '@somnio/core';
import { createDatabase } from '../../src/db.ts';
import type { DatabaseTimeouts, SomnioDatabase } from '../../src/db.ts';
import { resolvePostgresConfiguration } from '../../src/postgresConfig.ts';
import { PostgresAccountRepository } from '../../src/repositories/accounts.ts';
import { PostgresCharacterRepository } from '../../src/repositories/characters.ts';
import { PostgresItemRepository } from '../../src/repositories/items.ts';
import { holdLock, startDatabase } from './support/harness.ts';
import type { DatabaseHarness } from './support/harness.ts';

/** Awaits `work`, which must reject, and how long that took. */
async function rejection(work: Promise<unknown>): Promise<{ error: unknown; ms: number }> {
  const started = performance.now();
  try {
    await work;
  } catch (error) {
    return { error, ms: performance.now() - started };
  }
  throw new Error('expected a rejection');
}

describe('the pool timeouts', () => {
  let harness: DatabaseHarness;
  let opened: SomnioDatabase[] = [];
  let counter = 0;

  /** A pool over the test database with `timeouts` over the defaults. */
  function withTimeouts(timeouts: Partial<DatabaseTimeouts>, onPoolError?: (error: Error) => void): SomnioDatabase {
    const db = createDatabase(resolvePostgresConfiguration({ SOMNIO_DATABASE_URL: harness.url, SOMNIO_DATABASE_TLS: 'disable' }, false), onPoolError, timeouts);
    opened.push(db);
    return db;
  }

  async function newCharacter(inventory: Inventory): Promise<Character> {
    counter += 1;
    const account = await new PostgresAccountRepository(harness.db).create(`stall-${counter}@example.com`, 'h');
    return new PostgresCharacterRepository(harness.db).create(account.id, `Stall ${counter}`, 'vigils', inventory);
  }

  async function storedRow(id: string) {
    return harness.db.selectFrom('characters').select(['last_seen', 'coins']).where('id', '=', id).executeTakeFirstOrThrow();
  }

  beforeAll(async () => {
    harness = await startDatabase();
  });

  afterAll(async () => {
    for (const db of opened) await db.destroy();
    opened = [];
    await harness.stop();
  });

  it('cancels a statement that runs past the statement timeout', async () => {
    const { error, ms } = await rejection(sql`SELECT pg_sleep(2)`.execute(withTimeouts({ statementMs: 300 })));
    expect(error).toMatchObject({ code: '57014' });
    expect(ms).toBeLessThan(1000);
  });

  it('rolls back a checkpoint that waits on a character row another connection holds', async () => {
    const character = await newCharacter({ coins: 5, equipped: {}, bag: [] });
    const before = await storedRow(character.id);
    const release = await holdLock(harness.connect(), (transaction) =>
      transaction.selectFrom('characters').select('id').where('id', '=', character.id).forUpdate().execute(),
    );
    const { error } = await rejection(
      new PostgresCharacterRepository(withTimeouts({ statementMs: 300 })).persistCheckpoint(
        { ...character, lastSeen: new Date(Date.now() + 60_000) },
        { coins: 9, equipped: {}, bag: [] },
      ),
    );
    await release();
    expect(error).toMatchObject({ code: '57014' });
    expect(await storedRow(character.id)).toEqual(before);
  });

  /** The character row is updated before the items are replaced, so this cancel lands part-way through the checkpoint. */
  it('rolls back the part of a checkpoint already run when a later statement times out', async () => {
    const character = await newCharacter({ coins: 5, equipped: {}, bag: [{ place: 0, item: commonInstance('dagger') }] });
    const before = await storedRow(character.id);
    const itemsBefore = await new PostgresItemRepository(harness.db).load(character.id);
    const release = await holdLock(harness.connect(), (transaction) =>
      transaction.selectFrom('items').select('id').where('character_id', '=', character.id).forUpdate().execute(),
    );
    const { error } = await rejection(
      new PostgresCharacterRepository(withTimeouts({ statementMs: 300 })).persistCheckpoint(
        { ...character, lastSeen: new Date(Date.now() + 60_000) },
        { coins: 9, equipped: {}, bag: [] },
      ),
    );
    await release();
    expect(error).toMatchObject({ code: '57014' });
    expect(await storedRow(character.id)).toEqual(before);
    expect(await new PostgresItemRepository(harness.db).load(character.id)).toEqual(itemsBefore);
  });

  it('refuses a query that waits past the connect timeout for a pooled connection', async () => {
    const db = withTimeouts({ connectMs: 300 });
    const releases = await Promise.all(Array.from({ length: 10 }, () => holdLock(db, (transaction) => sql`SELECT 1`.execute(transaction))));
    const { error, ms } = await rejection(sql`SELECT 1`.execute(db));
    for (const release of releases) await release();
    expect(String(error)).toContain('timeout exceeded when trying to connect');
    expect(ms).toBeLessThan(1000);
  });

  /** The pool must survive Postgres closing a connection it has checked out, which nobody but the client hears of. */
  it('ends a transaction left idle past the idle-in-transaction timeout, reports why, and the pool goes on', async () => {
    const reported: unknown[] = [];
    const db = withTimeouts({ idleInTransactionMs: 300 }, (error) => reported.push(error));
    const { error } = await rejection(
      db.transaction().execute(async (transaction) => {
        await sql`SELECT 1`.execute(transaction);
        await delay(800);
        await sql`SELECT 1`.execute(transaction);
      }),
    );
    expect(String(error)).toContain('not queryable');
    expect(reported).toMatchObject([{ code: '25P03' }]);
    expect((await sql<{ one: number }>`SELECT 1 AS one`.execute(db)).rows).toEqual([{ one: 1 }]);
  });

  it('reports a connection Postgres ends while it is idle in the pool, and the pool goes on', async () => {
    const reported: unknown[] = [];
    const db = withTimeouts({}, (error) => reported.push(error));
    const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db);
    await sql`SELECT pg_terminate_backend(${rows[0]!.pid})`.execute(harness.db);
    await vi.waitFor(() => expect(reported).toMatchObject([{ code: '57P01' }]), { timeout: 2000 });
    expect((await sql<{ one: number }>`SELECT 1 AS one`.execute(db)).rows).toEqual([{ one: 1 }]);
  });

  /** Postgres's own limit is 5 s here, so only the client's backstop can end the wait within a second. */
  it('gives up on a query with no answer past the query timeout', async () => {
    const { error, ms } = await rejection(sql`SELECT pg_sleep(2)`.execute(withTimeouts({ statementMs: 5000, queryMs: 300 })));
    expect(String(error)).toContain('Query read timeout');
    expect(ms).toBeLessThan(1000);
  });
});
