import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newItemId, plainInstance } from '@somnio/core';
import type { Character, Inventory, ItemInstance } from '@somnio/core';
import { PostgresAccountRepository } from '../../src/repositories/accounts.ts';
import { PostgresCharacterRepository } from '../../src/repositories/characters.ts';
import { RepositoryDecodingError } from '../../src/repositories/errors.ts';
import { bagOf } from '../../../core/test/support/items.ts';
import { PostgresItemRepository } from '../../src/repositories/items.ts';
import { startDatabase } from './support/harness.ts';
import type { DatabaseHarness } from './support/harness.ts';

const NOTHING: Inventory = { coins: 0, equipped: {}, bag: [] };

describe('item repository', () => {
  let harness: DatabaseHarness;
  let accounts: PostgresAccountRepository;
  let characters: PostgresCharacterRepository;
  let items: PostgresItemRepository;
  let counter = 0;

  async function newCharacter(inventory: Inventory = NOTHING): Promise<Character> {
    counter += 1;
    const account = await accounts.create(`item-owner-${counter}@example.com`, 'h');
    return characters.create(account.id, `Owner ${counter}`, 'vigils', inventory);
  }

  /** Stores the inventory through a checkpoint, as the server saves it. */
  async function checkpoint(character: Character, inventory: Inventory): Promise<void> {
    counter += 1;
    expect(await characters.persistCheckpoint({ ...character, lastSeen: new Date(character.lastSeen.getTime() + counter * 1000) }, inventory)).toBe(true);
  }

  beforeAll(async () => {
    harness = await startDatabase();
    accounts = new PostgresAccountRepository(harness.db);
    characters = new PostgresCharacterRepository(harness.db);
    items = new PostgresItemRepository(harness.db);
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('saves and reloads the coins, the items worn in their slots with their affixes, a ring on each ring slot, and the bag at its places', async () => {
    const character = await newCharacter();
    const [first, second, third] = [newItemId(), newItemId(), newItemId()].sort();
    const dagger: ItemInstance = { ...plainInstance('dagger'), id: first! };
    const cap: ItemInstance = { ...plainInstance('cap'), id: second! };
    const tunic: ItemInstance = { ...plainInstance('tunic'), id: third! };
    const sword: ItemInstance = {
      ...plainInstance('sword'),
      rarity: 'rare',
      affixes: [
        { affixId: 'damage', value: 2 },
        { affixId: 'swing-speed', value: 5 },
        { affixId: 'balance-recovery', value: 12 },
      ],
    };
    const amulet: ItemInstance = { ...plainInstance('amulet'), rarity: 'magic', affixes: [{ affixId: 'spirit', value: 4 }] };
    const ring = plainInstance('ring');
    const secondRing: ItemInstance = { ...plainInstance('ring'), rarity: 'magic', affixes: [{ affixId: 'mend-depth', value: 2 }] };
    const inventory: Inventory = {
      coins: 137,
      equipped: { mainHand: sword, neck: amulet, head: cap, ring1: ring, ring2: secondRing },
      bag: [
        { place: 3, item: tunic },
        { place: 17, item: dagger },
      ],
    };
    await checkpoint(character, inventory);
    expect(await items.load(character.id)).toEqual(inventory);
  });

  it('replaces the items with each checkpoint, an empty one included', async () => {
    const character = await newCharacter({ coins: 100, equipped: {}, bag: bagOf([plainInstance('cudgel')]) });
    const moonstone = plainInstance('moonstone');
    await checkpoint(character, { coins: 40, equipped: { offHand: moonstone }, bag: [] });
    expect(await items.load(character.id)).toEqual({ coins: 40, equipped: { offHand: moonstone }, bag: [] });
    await checkpoint(character, NOTHING);
    expect(await items.load(character.id)).toEqual(NOTHING);
  });

  it('rolls a checkpoint back when an item in it fails, leaving the stored items as they were', async () => {
    const kept: Inventory = { coins: 100, equipped: {}, bag: bagOf([plainInstance('cudgel')]) };
    const character = await newCharacter(kept);
    // One id twice violates the primary key after the old rows are deleted and the coins written.
    const twice = plainInstance('dagger');
    await expect(
      characters.persistCheckpoint(
        { ...character, lastSeen: new Date() },
        {
          coins: 5,
          equipped: {},
          bag: [
            { place: 0, item: twice },
            { place: 1, item: twice },
          ],
        },
      ),
    ).rejects.toThrow();
    expect(await items.load(character.id)).toEqual(kept);
  });

  it.each([
    [
      'two items worn in one slot',
      sql`INSERT INTO items (id, character_id, base_id, tier, rarity, affixes, equipped_slot)
      SELECT gen_random_uuid(), id, 'dagger', 1, 'plain', '[]', 'mainHand' FROM characters WHERE name = 'Odd'`,
    ],
    ['coins below zero', sql`UPDATE characters SET coins = -1 WHERE name = 'Odd'`],
    ['a tier past the fifth', sql`UPDATE items SET tier = 6 FROM characters WHERE characters.id = items.character_id AND characters.name = 'Odd'`],
    ['an unknown rarity', sql`UPDATE items SET rarity = 'legendary' FROM characters WHERE characters.id = items.character_id AND characters.name = 'Odd'`],
    ['an unknown slot', sql`UPDATE items SET equipped_slot = 'charm' FROM characters WHERE characters.id = items.character_id AND characters.name = 'Odd'`],
    [
      'a bag place past the bag',
      sql`UPDATE items SET equipped_slot = NULL, bag_place = 24 FROM characters WHERE characters.id = items.character_id AND characters.name = 'Odd'`,
    ],
    [
      'two items at one bag place',
      sql`INSERT INTO items (id, character_id, base_id, tier, rarity, affixes, bag_place)
      SELECT gen_random_uuid(), id, 'dagger', 1, 'plain', '[]', place FROM characters, (VALUES (5), (5)) AS places (place) WHERE name = 'Odd'`,
    ],
    [
      'an item both worn and in the bag',
      sql`UPDATE items SET bag_place = 0 FROM characters WHERE characters.id = items.character_id AND characters.name = 'Odd'`,
    ],
    [
      'an item neither worn nor in the bag',
      sql`UPDATE items SET equipped_slot = NULL FROM characters WHERE characters.id = items.character_id AND characters.name = 'Odd'`,
    ],
  ])('refuses %s through the constraints', async (_label, corrupt) => {
    const account = await accounts.create(`odd-${crypto.randomUUID().slice(0, 6)}@example.com`, 'h');
    await characters.create(account.id, 'Odd', 'vigils', { coins: 0, equipped: { mainHand: plainInstance('cudgel') }, bag: [] });
    await expect(corrupt.execute(harness.db)).rejects.toThrow();
    await sql`DELETE FROM characters WHERE name = 'Odd'`.execute(harness.db);
  });

  it.each([
    ['a base', sql`UPDATE items SET base_id = 'lantern'`],
    ['an affix', sql`UPDATE items SET affixes = '[{"affixId": "luck", "value": 3}]'`],
    ['a value that is no whole number', sql`UPDATE items SET affixes = '[{"affixId": "damage", "value": 1.5}]'`],
    ['an item worn in a slot its base does not fit', sql`UPDATE items SET equipped_slot = 'offHand'`],
    ['a ring worn round the neck', sql`UPDATE items SET base_id = 'ring', equipped_slot = 'neck'`],
  ])('throws on %s it does not know', async (_label, corrupt) => {
    const character = await newCharacter({ coins: 0, equipped: { mainHand: plainInstance('cudgel') }, bag: [] });
    await sql`${corrupt} WHERE character_id = ${character.id}`.execute(harness.db);
    await expect(items.load(character.id)).rejects.toThrow(RepositoryDecodingError);
  });
});
