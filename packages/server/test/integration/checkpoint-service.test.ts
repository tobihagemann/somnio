import { afterAll, beforeAll, expect, it } from 'vitest';
import { headingFromCardinal, plainInstance } from '@somnio/core';
import { PostgresAccountRepository, PostgresCharacterRepository, PostgresItemRepository, STARTER_SECTOR, hashPassword } from '@somnio/data';
import { ConnectionOutbox } from '../../src/connection/outbox.ts';
import { starterInventory } from '../../src/handlers/starterInventory.ts';
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
  const kit = starterInventory();
  const character = await new PostgresCharacterRepository(harness.db).create(account.id, name, 'vigils', kit);
  const space = dependencies.worldRouter.space(STARTER_SECTOR)!;
  const staged = {
    ...character,
    position: { x: 7.25, z: 5.5 },
    facing: headingFromCardinal('north'),
    energy: { ...character.energy, healthCurrent: 42 },
  };
  const moonstone = plainInstance('moonstone');
  space.attach(staged, { ...kit, coins: 60, equipped: { offHand: moonstone } }, new ConnectionOutbox(1024), 0, 'en');

  await dependencies.worldRouter.checkpointAll();

  const reloaded = (await new PostgresCharacterRepository(harness.db).findByName(name))!;
  expect(reloaded.position).toEqual({ x: 7.25, z: 5.5 });
  expect(reloaded.facing).toBe(headingFromCardinal('north'));
  expect(reloaded.energy.healthCurrent).toBe(42);
  expect(await new PostgresItemRepository(harness.db).load(character.id)).toEqual({ ...kit, coins: 60, equipped: { offHand: moonstone } });
});
