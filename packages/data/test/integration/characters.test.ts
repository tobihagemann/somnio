import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NO_LUCIDITY, NO_QUESTS, NO_STATS, fullPools, headingFromCardinal, plainInstance } from '@somnio/core';
import type { Character, Inventory, Lucidity, QuestLog } from '@somnio/core';
import { PostgresAccountRepository } from '../../src/repositories/accounts.ts';
import { CharacterNameTakenError, PostgresCharacterRepository, hasBeenPlayed } from '../../src/repositories/characters.ts';
import { RepositoryDecodingError } from '../../src/repositories/errors.ts';
import { bagOf } from '../../../core/test/support/items.ts';
import { PostgresItemRepository } from '../../src/repositories/items.ts';
import { PostgresQuestRepository } from '../../src/repositories/quests.ts';
import { startDatabase } from './support/harness.ts';
import type { DatabaseHarness } from './support/harness.ts';

const NOTHING: Inventory = { coins: 0, equipped: {}, bag: [] };

describe('character repository', () => {
  let harness: DatabaseHarness;
  let accounts: PostgresAccountRepository;
  let characters: PostgresCharacterRepository;
  let items: PostgresItemRepository;

  beforeAll(async () => {
    harness = await startDatabase();
    accounts = new PostgresAccountRepository(harness.db);
    characters = new PostgresCharacterRepository(harness.db);
    items = new PostgresItemRepository(harness.db);
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('round-trips create and findByName with every energy field, the starting coins and items, and never played', async () => {
    const account = await accounts.create('alice@example.com', 'hash');
    const kit: Inventory = { coins: 100, equipped: {}, bag: bagOf([plainInstance('cudgel')]) };
    const created = await characters.create(account.id, 'Alice the Bold', 'lumina', kit);
    const fetched = await characters.findByName('Alice the Bold');
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.lastSeen).toEqual(created.lastSeen);
    expect(hasBeenPlayed(fetched!)).toBe(false);
    expect(await items.load(created.id)).toEqual(kit);
    expect(fetched?.people).toBe('lumina');
    expect(fetched?.space).toBe('EdariaLibrary');
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

  it('surfaces a taken name and a confusable one as a taken name, leaving no starting items behind', async () => {
    const owner = await accounts.create('owner-a@example.com', 'h');
    const other = await accounts.create('owner-b@example.com', 'h');
    await characters.create(owner.id, 'ADMIN', 'vigils', NOTHING);
    await expect(characters.create(other.id, 'admin', 'vigils', { coins: 100, equipped: {}, bag: bagOf([plainInstance('cudgel')]) })).rejects.toThrow(
      CharacterNameTakenError,
    );
    // All-Cyrillic "АDMIN" slips past `name_normalized`; the confusable skeleton catches it.
    await expect(characters.create(other.id, 'АDMIN', 'vigils', { coins: 100, equipped: {}, bag: bagOf([plainInstance('cudgel')]) })).rejects.toThrow(
      CharacterNameTakenError,
    );
    expect(await characters.findByAccount(other.id)).toEqual([]);
    const rows = await sql<{
      count: string;
    }>`SELECT COUNT(*) AS count FROM items i JOIN characters c ON c.id = i.character_id WHERE c.account_id = ${other.id}`.execute(harness.db);
    expect(rows.rows[0]?.count).toBe('0');
  });

  it('stores the same NFKC base as the runtime computes', async () => {
    // Guards against ICU version skew between Node and postgres:16 — the two uniqueness layers
    // must agree on the normalized base. Full-width "Ｍｅｒｃｕｓ" exercises compatibility folding.
    const owner = await accounts.create('nfkc@example.com', 'h');
    const name = 'Ｍｅｒｃｕｓ';
    await characters.create(owner.id, name, 'vigils', NOTHING);
    const stored = await sql<{
      name_normalized: string;
    }>`SELECT name_normalized FROM characters WHERE name = ${name}`.execute(harness.db);
    expect(stored.rows[0]?.name_normalized).toBe(name.normalize('NFKC').toLowerCase());
  });

  it.each([
    ['health', '150, 100, 100, 100, 100, 100'],
    ['balance', '100, 100, 150, 100, 100, 100'],
    ['spirit', '100, 100, 100, 100, 150, 100'],
  ])('blocks %s_current greater than its max through the CHECK constraint', async (label, energy) => {
    const account = await accounts.create(`check-${label}@example.com`, 'h');
    await expect(
      sql`INSERT INTO characters (
        id, account_id, name, people, space, position_x, position_z, facing,
        health_current, health_max, balance_current, balance_max, spirit_current, spirit_max, last_seen, name_skeleton, coins
      ) VALUES (
        ${crypto.randomUUID()}, ${account.id}, ${`over-${label}`}, 'vigils', 'EdariaLibrary', 0, 0, 0,
        ${sql.raw(energy)}, NOW(), ${`over-${label}`}, 0
      )`.execute(harness.db),
    ).rejects.toThrow();
  });

  it('reports false from snapshot when no row matches', async () => {
    const phantom: Character = {
      id: crypto.randomUUID(),
      name: 'Phantom',
      people: 'sopors',
      space: 'EdariaLibrary',
      position: { x: 0, z: 0 },
      facing: 0,
      energy: fullPools(NO_STATS),
      lucidity: NO_LUCIDITY,
      quests: NO_QUESTS,
      lastSeen: new Date(),
    };
    expect(await characters.snapshot(phantom)).toBe(false);
  });

  it('skips a snapshot whose last_seen is older than the persisted row', async () => {
    const account = await accounts.create('stale-tester@example.com', 'stub');
    const original = await characters.create(account.id, 'Stale', 'umbrae', NOTHING);

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

  it('persists a checkpoint atomically and skips a stale one without touching the coins or the items', async () => {
    const account = await accounts.create('checkpoint-tester@example.com', 'stub');
    const original = await characters.create(account.id, 'Checkpoint', 'vigils', NOTHING);
    const carried: Inventory = { coins: 100, equipped: { mainHand: plainInstance('cudgel') }, bag: [] };

    const fresh = {
      ...original,
      position: { x: 8, z: 8 },
      lastSeen: new Date(original.lastSeen.getTime() + 60_000),
    };
    expect(await characters.persistCheckpoint(fresh, carried)).toBe(true);
    expect(await items.load(original.id)).toEqual(carried);

    const stale = { ...original, position: { x: 1, z: 1 }, lastSeen: original.lastSeen };
    expect(await characters.persistCheckpoint(stale, NOTHING)).toBe(false);
    expect(await items.load(original.id)).toEqual(carried);
    expect((await characters.findByName('Checkpoint'))?.position).toEqual({ x: 8, z: 8 });
  });

  it('round-trips role, ranks with practice, and study through a checkpoint, by name and by account', async () => {
    const account = await accounts.create('lucid@example.com', 'stub');
    const original = await characters.create(account.id, 'Lucid', 'lumina', NOTHING);
    const lucidity: Lucidity = {
      role: 'healer',
      ranks: [
        { teachingId: 'depth', rank: 0, practice: 7.25 },
        { teachingId: 'touch', rank: 2, practice: 12.5 },
      ],
      study: 'depth',
    };
    const grown = { ...original, lucidity, lastSeen: new Date(original.lastSeen.getTime() + 60_000) };
    expect(await characters.persistCheckpoint(grown, NOTHING)).toBe(true);
    expect(await characters.findByName('Lucid')).toEqual(grown);
    expect(await characters.findByAccount(account.id)).toEqual([grown]);

    // A later checkpoint replaces the rank rows rather than adding to them.
    const later = {
      ...grown,
      lucidity: {
        ...lucidity,
        ranks: [{ teachingId: 'touch' as const, rank: 3, practice: 0 }],
        study: undefined,
      },
      lastSeen: new Date(grown.lastSeen.getTime() + 60_000),
    };
    expect(await characters.persistCheckpoint(later, NOTHING)).toBe(true);
    expect(await characters.findByName('Lucid')).toEqual(later);
  });

  it('leaves the rank rows alone when a checkpoint is skipped as stale', async () => {
    const account = await accounts.create('stale-ranks@example.com', 'stub');
    const original = await characters.create(account.id, 'StaleRanks', 'vigils', NOTHING);
    const ranks = [{ teachingId: 'strike' as const, rank: 1, practice: 3 }];
    const fresh = { ...original, lucidity: { ...NO_LUCIDITY, role: 'fighter' as const, ranks }, lastSeen: new Date(original.lastSeen.getTime() + 60_000) };
    expect(await characters.persistCheckpoint(fresh, NOTHING)).toBe(true);
    expect(await characters.persistCheckpoint({ ...original, lastSeen: original.lastSeen }, NOTHING)).toBe(false);
    expect((await characters.findByName('StaleRanks'))?.lucidity.ranks).toEqual(ranks);
  });

  it('leaves the quest rows alone when a checkpoint is skipped as stale', async () => {
    const account = await accounts.create('stale-quests@example.com', 'stub');
    const original = await characters.create(account.id, 'StaleQuests', 'vigils', NOTHING);
    const quests: QuestLog = { active: [{ questId: 'restless-graves', progress: [3] }], done: ['fighter-trial'] };
    const fresh = { ...original, quests, lastSeen: new Date(original.lastSeen.getTime() + 60_000) };
    expect(await characters.persistCheckpoint(fresh, NOTHING)).toBe(true);
    const older: QuestLog = { active: [{ questId: 'newcomer-errand', progress: [1, 0] }], done: [] };
    expect(await characters.persistCheckpoint({ ...original, quests: older, lastSeen: original.lastSeen }, NOTHING)).toBe(false);
    expect(await new PostgresQuestRepository(harness.db).load(original.id)).toEqual(quests);
  });

  it.each([
    ['a studied teaching', sql`UPDATE characters SET study = 'fireball' WHERE name = 'Odd'`],
    [
      "a rank's teaching",
      sql`INSERT INTO character_ranks (character_id, teaching_id, rank, practice) SELECT id, 'fireball', 1, 0 FROM characters WHERE name = 'Odd'`,
    ],
  ])('throws on %s it does not know', async (_label, corrupt) => {
    const account = await accounts.create(`odd-${crypto.randomUUID().slice(0, 6)}@example.com`, 'h');
    await characters.create(account.id, 'Odd', 'vigils', NOTHING);
    await corrupt.execute(harness.db);
    await expect(characters.findByName('Odd')).rejects.toThrow(RepositoryDecodingError);
    await sql`DELETE FROM characters WHERE name = 'Odd'`.execute(harness.db);
  });

  it('admits the three roles and refuses any other role and a pool below zero through the CHECK constraints', async () => {
    const account = await accounts.create('checks@example.com', 'h');
    await characters.create(account.id, 'Checked', 'vigils', NOTHING);
    for (const role of ['fighter', 'healer', 'mystic']) await sql`UPDATE characters SET role = ${role} WHERE name = 'Checked'`.execute(harness.db);
    await expect(sql`UPDATE characters SET role = 'heiler' WHERE name = 'Checked'`.execute(harness.db)).rejects.toThrow();
    await expect(sql`UPDATE characters SET health_current = -1 WHERE name = 'Checked'`.execute(harness.db)).rejects.toThrow();
  });

  it('resolves nothing for an unknown name', async () => {
    expect(await characters.findByName('nonexistent')).toBeUndefined();
  });

  it('lists no characters for an account without any', async () => {
    const account = await accounts.create('empty@example.com', 'h');
    expect(await characters.findByAccount(account.id)).toEqual([]);
  });

  it('throws on an unknown people', async () => {
    const account = await accounts.create('weird@example.com', 'h');
    await sql`INSERT INTO characters (
      id, account_id, name, people, space, position_x, position_z, facing,
      health_current, health_max, balance_current, balance_max, spirit_current, spirit_max, last_seen, name_skeleton, coins
    ) VALUES (
      ${crypto.randomUUID()}, ${account.id}, 'WeirdPeople', 'elves', 'EdariaLibrary', 0, 0, 0,
      100, 100, 100, 100, 100, 100, NOW(), 'weirdpeople', 0
    )`.execute(harness.db);
    await expect(characters.findByName('WeirdPeople')).rejects.toThrow(RepositoryDecodingError);
  });

  it('lists every character on the account, the one played last first and those never played last by name', async () => {
    const account = await accounts.create('lister@example.com', 'hash');
    await characters.create(account.id, 'Delta', 'vigils', NOTHING);
    await characters.create(account.id, 'Beta', 'vigils', NOTHING);
    const earlier = await characters.create(account.id, 'Gamma', 'lumina', NOTHING);
    const later = await characters.create(account.id, 'Alpha', 'lumina', NOTHING);
    expect(await characters.snapshot({ ...earlier, lastSeen: new Date(Date.now() - 60_000) })).toBe(true);
    expect(await characters.snapshot({ ...later, lastSeen: new Date() })).toBe(true);
    expect((await characters.findByAccount(account.id)).map((character) => character.name)).toEqual(['Alpha', 'Gamma', 'Beta', 'Delta']);
  });

  it("deletes one of the account's characters with its rows, and not another account's", async () => {
    const owner = await accounts.create('deleter@example.com', 'h');
    const stranger = await accounts.create('stranger@example.com', 'h');
    const doomed = await characters.create(owner.id, 'Doomed', 'vigils', { coins: 100, equipped: {}, bag: bagOf([plainInstance('cudgel')]) });
    const keptKit: Inventory = { coins: 100, equipped: {}, bag: bagOf([plainInstance('cudgel')]) };
    const kept = await characters.create(owner.id, 'Kept', 'vigils', keptKit);
    const grown = {
      ...doomed,
      lucidity: { ...NO_LUCIDITY, role: 'fighter' as const, ranks: [{ teachingId: 'strike' as const, rank: 1, practice: 0 }] },
      quests: { active: [{ questId: 'follow-through-task' as const, progress: [1] }], done: ['fighter-trial' as const] },
      lastSeen: new Date(),
    };
    expect(await characters.persistCheckpoint(grown, { coins: 100, equipped: {}, bag: bagOf([plainInstance('dagger')]) })).toBe(true);

    expect(await characters.delete(stranger.id, doomed.id)).toBe(false);
    expect(await characters.delete(owner.id, doomed.id)).toBe(true);
    expect(await characters.delete(owner.id, doomed.id)).toBe(false);

    expect((await characters.findByAccount(owner.id)).map((character) => character.id)).toEqual([kept.id]);
    const doomedItems = await sql<{ count: string }>`SELECT COUNT(*) AS count FROM items WHERE character_id = ${doomed.id}`.execute(harness.db);
    expect(doomedItems.rows[0]?.count).toBe('0');
    expect(await items.load(kept.id)).toEqual(keptKit);
    const ranks = await sql<{ count: string }>`SELECT COUNT(*) AS count FROM character_ranks WHERE character_id = ${doomed.id}`.execute(harness.db);
    expect(ranks.rows[0]?.count).toBe('0');
    const quests = await sql<{ count: string }>`SELECT COUNT(*) AS count FROM character_quests WHERE character_id = ${doomed.id}`.execute(harness.db);
    expect(quests.rows[0]?.count).toBe('0');
  });
});
