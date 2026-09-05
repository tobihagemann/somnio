import { afterAll, beforeAll, expect, it } from 'vitest';
import { npcRuntimePosition } from '@somnio/core';
import { PostgresNPCDialogStateRepository } from '@somnio/data';
import { ConnectionOutbox } from '../../src/connection/outbox.ts';
import { makeCharacter } from '../support/sectorFactory.ts';
import { fixtureSectors, makeDatabaseDependencies, startDatabase } from './support/harness.ts';
import type { DatabaseHarness } from './support/harness.ts';

let harness: DatabaseHarness;

beforeAll(async () => {
  harness = await startDatabase();
});
afterAll(async () => {
  await harness.stop();
});

it('runAITickAcrossSectors persists the NPC dialog cursor through the repository', async () => {
  const dependencies = await makeDatabaseDependencies(harness.db);
  const bibliothek = fixtureSectors().get('EdariaBibliothek')!;
  const libus = bibliothek.npcs[0]!;
  const sector = dependencies.worldRouter.sector('EdariaBibliothek')!;
  const entityIndex = sector.attach(makeCharacter(npcRuntimePosition(libus), 'talker', 'EdariaBibliothek'), [], new ConnectionOutbox(1024));
  sector.handleBumpNPC(1, entityIndex);
  await dependencies.worldRouter.runAITickAcrossSectors();
  const persisted = await new PostgresNPCDialogStateRepository(harness.db).find('EdariaBibliothek', 1);
  expect(persisted?.scriptStep).toBe(2);
});
