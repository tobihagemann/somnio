import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresAccountRepository } from '../../src/repositories/accounts.ts';
import { startDatabase } from './support/harness.ts';
import type { DatabaseHarness } from './support/harness.ts';

describe('account repository', () => {
  let harness: DatabaseHarness;
  let accounts: PostgresAccountRepository;

  beforeAll(async () => {
    harness = await startDatabase();
    accounts = new PostgresAccountRepository(harness.db);
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('round-trips create and findByName', async () => {
    const created = await accounts.create('alice', 'hash', 'alice@example.com');
    const fetched = await accounts.findByName('alice');
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.passwordHash).toBe('hash');
    expect(fetched?.email).toBe('alice@example.com');
  });

  it('rejects a duplicate name', async () => {
    await expect(accounts.create('alice', 'other', 'other@example.com')).rejects.toThrow();
  });

  it('round-trips findById', async () => {
    const created = await accounts.create('bob', 'hash', 'bob@example.com');
    const fetched = await accounts.findById(created.id);
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.name).toBe('bob');
  });

  it('resolves nothing for an unknown id', async () => {
    expect(await accounts.findById(crypto.randomUUID())).toBeUndefined();
  });

  it('finds by name case-insensitively via name_normalized', async () => {
    await accounts.create('Carol', 'hash', 'carol@example.com');
    const lower = await accounts.findByName('carol');
    const upper = await accounts.findByName('CAROL');
    expect(lower?.name).toBe('Carol');
    expect(upper?.id).toBe(lower?.id);
  });

  it('collides a confusable name via the skeleton constraint', async () => {
    await accounts.create('ADMIN', 'hash', 'admin@example.com');
    // Cyrillic "АDMIN" (U+0410) is not NFKC-equivalent to Latin "ADMIN" but shares its skeleton.
    await expect(accounts.create('АDMIN', 'hash2', 'evil@example.com')).rejects.toThrow();
  });

  it('collides an NFKC-equivalent name with the existing one', async () => {
    await accounts.create('dave', 'hash', 'dave@example.com');
    // Full-width "ｄａｖｅ" NFKC-normalizes to ASCII "dave".
    await expect(accounts.create('ｄａｖｅ', 'hash2', 'evil@example.com')).rejects.toThrow();
  });
});
