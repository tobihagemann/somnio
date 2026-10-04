import { afterAll, beforeAll, expect, it } from 'vitest';
import { OUTDOOR_SPACE_ID, heading } from '@somnio/core';
import { PostgresCharacterRepository, PostgresInventoryRepository, PostgresRegistrationRepository, hashPassword } from '@somnio/data';
import { STARTER_INVENTORY } from '../../src/handlers/starterInventory.ts';
import { TEST_PASSWORD, startDatabase, uniqueNickname } from './support/harness.ts';
import type { DatabaseHarness } from './support/harness.ts';

let harness: DatabaseHarness;

beforeAll(async () => {
  harness = await startDatabase();
});
afterAll(async () => {
  await harness.stop();
});

it('register then logout snapshot then load reproduces the character state', async () => {
  const name = uniqueNickname('roundtrip');
  const { character } = await new PostgresRegistrationRepository(harness.db).register({
    name,
    passwordHash: await hashPassword(TEST_PASSWORD),
    email: `${name}@example.invalid`,
    people: 'umbren',
    starterInventory: STARTER_INVENTORY,
  });
  const characters = new PostgresCharacterRepository(harness.db);
  // Fractional values pin the double precision round-trip; `lastSeen` is bumped so the stale guard accepts the write.
  const snapshot = {
    ...character,
    space: OUTDOOR_SPACE_ID,
    position: { x: 4.125, z: -7.5 },
    facing: heading(137.5),
    energy: { ...character.energy, healthCurrent: 75 },
    lastSeen: new Date(character.lastSeen.getTime() + 1000),
  };
  expect(await characters.snapshot(snapshot)).toBe(true);

  const reloaded = (await characters.findByName(name))!;
  expect(reloaded.space).toBe(OUTDOOR_SPACE_ID);
  expect(reloaded.position).toEqual({ x: 4.125, z: -7.5 });
  expect(reloaded.facing).toBe(heading(137.5));
  expect(reloaded.energy.healthCurrent).toBe(75);
  expect(reloaded.people).toBe('umbren');
  const inventory = await new PostgresInventoryRepository(harness.db).loadAll(character.id);
  expect(inventory.length).toBe(2);
  expect(inventory[0]).toEqual({ slot: 0, itemId: 'purse', quantity: 100, equippedHand: undefined });
});
