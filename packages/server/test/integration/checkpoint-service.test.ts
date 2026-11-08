import { afterAll, beforeAll, expect, it } from 'vitest';
import { headingFromCardinal } from '@somnio/core';
import { PostgresAccountRepository, PostgresCharacterRepository, PostgresInventoryRepository, STARTER_SECTOR, hashPassword } from '@somnio/data';
import { ConnectionOutbox } from '../../src/connection/outbox.ts';
import { STARTER_INVENTORY } from '../../src/handlers/starterInventory.ts';
import { TEST_PASSWORD, emailFor, makeDatabaseDependencies, startDatabase, uniqueName } from './support/harness.ts';
import type { DatabaseHarness } from './support/harness.ts';

let harness: DatabaseHarness;

beforeAll(async () => {
  harness = await startDatabase();
});
afterAll(async () => {
  await harness.stop();
});

it("checkpointAll persists every logged-in player's full character and inventory", async () => {
  const dependencies = await makeDatabaseDependencies(harness.db);
  const name = uniqueName('checkpoint');
  const account = await new PostgresAccountRepository(harness.db).create(emailFor(name), await hashPassword(TEST_PASSWORD));
  const character = await new PostgresCharacterRepository(harness.db).create(account.id, name, 'vigils', STARTER_INVENTORY);
  const space = dependencies.worldRouter.space(STARTER_SECTOR)!;
  const staged = {
    ...character,
    position: { x: 7.25, z: 5.5 },
    facing: headingFromCardinal('north'),
    energy: { ...character.energy, healthCurrent: 42 },
  };
  space.attach(staged, [...STARTER_INVENTORY], new ConnectionOutbox(1024), 0, 'en');

  await dependencies.worldRouter.checkpointAll();

  const reloaded = (await new PostgresCharacterRepository(harness.db).findByName(name))!;
  expect(reloaded.position).toEqual({ x: 7.25, z: 5.5 });
  expect(reloaded.facing).toBe(headingFromCardinal('north'));
  expect(reloaded.energy.healthCurrent).toBe(42);
  const inventory = await new PostgresInventoryRepository(harness.db).loadAll(character.id);
  expect(inventory.length).toBe(STARTER_INVENTORY.length);
});
