import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NO_LUCIDITY, fullPools, headingFromCardinal } from '@somnio/core';
import type { Character, InventoryRow, Lucidity } from '@somnio/core';
import { PostgresAccountRepository } from '../../src/repositories/accounts.ts';
import { PostgresCharacterRepository } from '../../src/repositories/characters.ts';
import { RepositoryDecodingError } from '../../src/repositories/errors.ts';
import { PostgresInventoryRepository } from '../../src/repositories/inventory.ts';
import { startDatabase } from './support/harness.ts';
import type { DatabaseHarness } from './support/harness.ts';

describe('character repository', () => {
  let harness: DatabaseHarness;
  let accounts: PostgresAccountRepository;
  let characters: PostgresCharacterRepository;
  let inventory: PostgresInventoryRepository;

  beforeAll(async () => {
    harness = await startDatabase();
    accounts = new PostgresAccountRepository(harness.db);
    characters = new PostgresCharacterRepository(harness.db);
    inventory = new PostgresInventoryRepository(harness.db);
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('round-trips create and findByName with every energy field', async () => {
    const account = await accounts.create('alice', 'hash', 'alice@example.com');
    const created = await characters.create(account.id, 'Alice the Bold', 'lumina');
    const fetched = await characters.findByName('Alice the Bold');
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.people).toBe('lumina');
    expect(fetched?.space).toBe('EdariaBibliothek');
    expect(fetched?.position).toEqual({ x: 0, z: 0 });
    expect(fetched?.facing).toBe(headingFromCardinal('south'));
    expect(fetched?.energy).toEqual({
      healthCurrent: 100,
      healthMax: 100,
      balanceCurrent: 100,
      balanceMax: 100,
      spiritCurrent: 100,
      spiritMax: 100,
    });
    expect(fetched?.lucidity).toEqual(NO_LUCIDITY);
  });

  it('stores a skeleton that rejects a confusable second character', async () => {
    const owner = await accounts.create('owner-a', 'h', 'a@example.com');
    const other = await accounts.create('owner-b', 'h', 'b@example.com');
    await characters.create(owner.id, 'ADMIN', 'wachen');
    await expect(characters.create(other.id, 'АDMIN', 'wachen')).rejects.toThrow();
  });

  it.each([
    ['health', '150, 100, 100, 100, 100, 100'],
    ['balance', '100, 100, 150, 100, 100, 100'],
    ['spirit', '100, 100, 100, 100, 150, 100'],
  ])('blocks %s_current greater than its max through the CHECK constraint', async (label, energy) => {
    const account = await accounts.create(`check-${label}`, 'h', `${label}@example.com`);
    await expect(
      sql`INSERT INTO characters (
        id, account_id, name, people, space, position_x, position_z, facing,
        health_current, health_max, balance_current, balance_max, spirit_current, spirit_max, last_seen, name_skeleton
      ) VALUES (
        ${crypto.randomUUID()}, ${account.id}, ${`over-${label}`}, 'wachen', 'EdariaBibliothek', 0, 0, 0,
        ${sql.raw(energy)}, NOW(), ${`over-${label}`}
      )`.execute(harness.db),
    ).rejects.toThrow();
  });

  it('reports false from snapshot when no row matches', async () => {
    const phantom: Character = {
      id: crypto.randomUUID(),
      name: 'Phantom',
      people: 'soporen',
      space: 'EdariaBibliothek',
      position: { x: 0, z: 0 },
      facing: 0,
      energy: fullPools(NO_LUCIDITY.ranks),
      lucidity: NO_LUCIDITY,
      lastSeen: new Date(),
    };
    expect(await characters.snapshot(phantom)).toBe(false);
  });

  it('skips a snapshot whose last_seen is older than the persisted row', async () => {
    const account = await accounts.create('stale-tester', 'stub', 's@x');
    const original = await characters.create(account.id, 'Stale', 'umbren');

    const fresh = {
      ...original,
      position: { x: 5, z: 5 },
      lastSeen: new Date(original.lastSeen.getTime() + 60_000),
    };
    expect(await characters.snapshot(fresh)).toBe(true);

    const stale = { ...original, position: { x: 99, z: 99 }, lastSeen: original.lastSeen };
    expect(await characters.snapshot(stale)).toBe(false);

    expect((await characters.findByName('Stale'))?.position).toEqual({ x: 5, z: 5 });
  });

  it('persists a checkpoint atomically and skips a stale one without touching inventory', async () => {
    const account = await accounts.create('checkpoint-tester', 'stub', 'cp@x');
    const original = await characters.create(account.id, 'Checkpoint', 'wachen');
    const purse: InventoryRow = { slot: 0, itemId: 'purse', quantity: 100, equippedHand: undefined };

    const fresh = {
      ...original,
      position: { x: 8, z: 8 },
      lastSeen: new Date(original.lastSeen.getTime() + 60_000),
    };
    expect(await characters.persistCheckpoint(fresh, [purse])).toBe(true);
    expect(await inventory.loadAll(original.id)).toEqual([purse]);

    const stale = { ...original, position: { x: 1, z: 1 }, lastSeen: original.lastSeen };
    expect(await characters.persistCheckpoint(stale, [])).toBe(false);
    expect(await inventory.loadAll(original.id)).toEqual([purse]);
    expect((await characters.findByName('Checkpoint'))?.position).toEqual({ x: 8, z: 8 });
  });

  it('round-trips role, ranks with practice, study, and task through a checkpoint, by name and by account', async () => {
    const account = await accounts.create('lucid', 'stub', 'lucid@x');
    const original = await characters.create(account.id, 'Lucid', 'lumina');
    const lucidity: Lucidity = {
      role: 'heiler',
      ranks: [
        { teachingId: 'depth', rank: 0, practice: 7.25 },
        { teachingId: 'touch', rank: 2, practice: 12.5 },
      ],
      study: 'depth',
      task: { role: 'heiler', teachingId: 'drawing-back', progress: 22.5 },
    };
    const grown = { ...original, lucidity, lastSeen: new Date(original.lastSeen.getTime() + 60_000) };
    expect(await characters.persistCheckpoint(grown, [])).toBe(true);
    expect(await characters.findByName('Lucid')).toEqual(grown);
    expect(await characters.findByAccount(account.id)).toEqual([grown]);

    // A later checkpoint replaces the rank rows rather than adding to them, and a trial is stored without a teaching.
    const later = {
      ...grown,
      lucidity: {
        ...lucidity,
        ranks: [{ teachingId: 'touch' as const, rank: 3, practice: 0 }],
        study: undefined,
        task: { role: 'heiler' as const, teachingId: undefined, progress: 1 },
      },
      lastSeen: new Date(grown.lastSeen.getTime() + 60_000),
    };
    expect(await characters.persistCheckpoint(later, [])).toBe(true);
    expect(await characters.findByName('Lucid')).toEqual(later);
  });

  it('leaves the rank rows alone when a checkpoint is skipped as stale', async () => {
    const account = await accounts.create('stale-ranks', 'stub', 'sr@x');
    const original = await characters.create(account.id, 'StaleRanks', 'wachen');
    const ranks = [{ teachingId: 'strike' as const, rank: 1, practice: 3 }];
    const fresh = { ...original, lucidity: { ...NO_LUCIDITY, role: 'kaempfer' as const, ranks }, lastSeen: new Date(original.lastSeen.getTime() + 60_000) };
    expect(await characters.persistCheckpoint(fresh, [])).toBe(true);
    expect(await characters.persistCheckpoint({ ...original, lastSeen: original.lastSeen }, [])).toBe(false);
    expect((await characters.findByName('StaleRanks'))?.lucidity.ranks).toEqual(ranks);
  });

  it.each([
    ['a role', sql`UPDATE characters SET task_role = 'mystiker' WHERE name = 'Odd'`],
    ['a studied teaching', sql`UPDATE characters SET study = 'fireball' WHERE name = 'Odd'`],
    [
      "a rank's teaching",
      sql`INSERT INTO character_ranks (character_id, teaching_id, rank, practice) SELECT id, 'fireball', 1, 0 FROM characters WHERE name = 'Odd'`,
    ],
  ])('throws on %s it does not know', async (_label, corrupt) => {
    const account = await accounts.create(`odd-${crypto.randomUUID().slice(0, 6)}`, 'h', 'odd@example.com');
    await characters.create(account.id, 'Odd', 'wachen');
    await corrupt.execute(harness.db);
    await expect(characters.findByName('Odd')).rejects.toThrow(RepositoryDecodingError);
    await sql`DELETE FROM characters WHERE name = 'Odd'`.execute(harness.db);
  });

  it.each([
    ['a teaching without a gate', sql`UPDATE characters SET task_role = 'heiler', task_teaching = 'touch' WHERE name = 'Odd'`],
    ["another role's gate", sql`UPDATE characters SET task_role = 'kaempfer', task_teaching = 'drawing-back' WHERE name = 'Odd'`],
  ])('drops a task naming %s', async (_label, corrupt) => {
    const account = await accounts.create(`odd-${crypto.randomUUID().slice(0, 6)}`, 'h', 'odd@example.com');
    await characters.create(account.id, 'Odd', 'wachen');
    await corrupt.execute(harness.db);
    expect((await characters.findByName('Odd'))?.lucidity.task).toBeUndefined();
    await sql`DELETE FROM characters WHERE name = 'Odd'`.execute(harness.db);
  });

  it('refuses a role outside the two and a pool below zero through the CHECK constraints', async () => {
    const account = await accounts.create('checks', 'h', 'checks@example.com');
    await characters.create(account.id, 'Checked', 'wachen');
    await expect(sql`UPDATE characters SET role = 'mystiker' WHERE name = 'Checked'`.execute(harness.db)).rejects.toThrow();
    await expect(sql`UPDATE characters SET health_current = -1 WHERE name = 'Checked'`.execute(harness.db)).rejects.toThrow();
  });

  it('resolves nothing for an unknown name', async () => {
    expect(await characters.findByName('nonexistent')).toBeUndefined();
  });

  it('lists no characters for an account without any', async () => {
    const account = await accounts.create('empty', 'h', 'e@example.com');
    expect(await characters.findByAccount(account.id)).toEqual([]);
  });

  it('throws on an unknown people', async () => {
    const account = await accounts.create('weird', 'h', 'w@example.com');
    await sql`INSERT INTO characters (
      id, account_id, name, people, space, position_x, position_z, facing,
      health_current, health_max, balance_current, balance_max, spirit_current, spirit_max, last_seen, name_skeleton
    ) VALUES (
      ${crypto.randomUUID()}, ${account.id}, 'WeirdPeople', 'elves', 'EdariaBibliothek', 0, 0, 0,
      100, 100, 100, 100, 100, 100, NOW(), 'weirdpeople'
    )`.execute(harness.db);
    await expect(characters.findByName('WeirdPeople')).rejects.toThrow(RepositoryDecodingError);
  });

  it('lists every character on the account ordered by name', async () => {
    const account = await accounts.create('lister', 'hash', 'l@example.com');
    await characters.create(account.id, 'Beta', 'wachen');
    await characters.create(account.id, 'Alpha', 'lumina');
    expect((await characters.findByAccount(account.id)).map((character) => character.name)).toEqual(['Alpha', 'Beta']);
  });
});
