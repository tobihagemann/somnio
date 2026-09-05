import { afterAll, beforeAll, expect, it } from 'vitest';
import { heading } from '@somnio/core';
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
    gender: 1,
    figure: 3,
    starterInventory: STARTER_INVENTORY,
  });
  const characters = new PostgresCharacterRepository(harness.db);
  // Fractional degrees pin the REAL column round-trip; `lastSeen` is bumped so the stale guard accepts the write.
  const snapshot = {
    ...character,
    position: { x: 4, y: 7 },
    facing: heading(137.5),
    energy: { ...character.energy, hpCurrent: 75 },
    lastSeen: new Date(character.lastSeen.getTime() + 1000),
  };
  expect(await characters.snapshot(snapshot)).toBe(true);

  const reloaded = (await characters.findByName(name))!;
  expect(reloaded.position).toEqual({ x: 4, y: 7 });
  expect(reloaded.facing).toBe(heading(137.5));
  expect(reloaded.energy.hpCurrent).toBe(75);
  expect(reloaded.figure).toBe(3);
  expect(reloaded.gender).toBe(1);
  const inventory = await new PostgresInventoryRepository(harness.db).loadAll(character.id);
  expect(inventory.length).toBe(2);
  expect(inventory[0]?.extras[0]).toEqual({ key: 'gold', value: 100 });
});
