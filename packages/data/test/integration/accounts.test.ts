import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postgresNormalizedKey } from '../../src/namePolicy/namePolicy.ts';
import { EmailTakenError, PostgresAccountRepository } from '../../src/repositories/accounts.ts';
import { PostgresCharacterRepository } from '../../src/repositories/characters.ts';
import { startDatabase } from './support/harness.ts';
import type { DatabaseHarness } from './support/harness.ts';

describe('account repository', () => {
  let harness: DatabaseHarness;
  let accounts: PostgresAccountRepository;
  let characters: PostgresCharacterRepository;

  beforeAll(async () => {
    harness = await startDatabase();
    accounts = new PostgresAccountRepository(harness.db);
    characters = new PostgresCharacterRepository(harness.db);
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('round-trips create and findByEmail', async () => {
    const created = await accounts.create('alice@example.com', 'hash');
    const fetched = await accounts.findByEmail('alice@example.com');
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.passwordHash).toBe('hash');
    expect(fetched?.email).toBe('alice@example.com');
  });

  it('creates the account alone, with no character', async () => {
    const account = await accounts.create('fighter-one@example.com', 'argon2-hash-stub');
    expect(await characters.findByAccount(account.id)).toEqual([]);
  });

  it('surfaces a duplicate email in another case as EmailTakenError', async () => {
    await expect(accounts.create('Alice@Example.com', 'other')).rejects.toThrow(EmailTakenError);
  });

  it('round-trips findById', async () => {
    const created = await accounts.create('bob@example.com', 'hash');
    const fetched = await accounts.findById(created.id);
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.email).toBe('bob@example.com');
  });

  it('resolves nothing for an unknown id', async () => {
    expect(await accounts.findById(crypto.randomUUID())).toBeUndefined();
  });

  it('finds by email case-insensitively via email_normalized', async () => {
    await accounts.create('Carol@Example.com', 'hash');
    const lower = await accounts.findByEmail('carol@example.com');
    const upper = await accounts.findByEmail('CAROL@EXAMPLE.COM');
    expect(lower?.email).toBe('Carol@Example.com');
    expect(upper?.id).toBe(lower?.id);
  });

  it('collides an NFKC-equivalent email with the existing one', async () => {
    await accounts.create('dave@example.com', 'hash');
    // Full-width "ｄａｖｅ" NFKC-normalizes to ASCII "dave".
    await expect(accounts.create('ｄａｖｅ@example.com', 'hash2')).rejects.toThrow(EmailTakenError);
  });

  /**
   * Guards against ICU version skew between Node and postgres:16: the login's account budget is
   * keyed by `postgresNormalizedKey`, so it must agree with the column `findByEmail` matches.
   * Full-width letters exercise compatibility folding; the dotted capital I and the final sigma
   * are where JavaScript's lowercasing and Postgres's differ.
   */
  it.each(['Ｍｅｒｃｕｓ@example.com', 'TOBİAS@example.invalid', 'ΟΔΥΣΣΕΥΣ@example.invalid', 'Ïda@example.invalid'])(
    'stores the key the account budget counts for %s',
    async (email) => {
      await accounts.create(email, 'nfkc');
      const stored = await sql<{
        email_normalized: string;
      }>`SELECT email_normalized FROM accounts WHERE email = ${email}`.execute(harness.db);
      expect(stored.rows[0]?.email_normalized).toBe(postgresNormalizedKey(email));
    },
  );
});
