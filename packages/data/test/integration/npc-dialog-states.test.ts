import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresNPCDialogStateRepository } from '../../src/repositories/npcDialogStates.ts';
import { startDatabase } from './support/harness.ts';
import type { DatabaseHarness } from './support/harness.ts';

describe('npc dialog state repository', () => {
  let harness: DatabaseHarness;
  let states: PostgresNPCDialogStateRepository;

  beforeAll(async () => {
    harness = await startDatabase();
    states = new PostgresNPCDialogStateRepository(harness.db);
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('moves the cursor forward on a composite-key upsert', async () => {
    await states.upsert({ sectorName: 'EdariaBibliothek', npcId: 'libus', scriptStep: 1 });
    await states.upsert({ sectorName: 'EdariaBibliothek', npcId: 'libus', scriptStep: 2 });
    expect((await states.find('EdariaBibliothek', 'libus'))?.scriptStep).toBe(2);
  });

  it('resets only the targeted row', async () => {
    await states.upsert({ sectorName: 'EdariaBibliothek', npcId: 'libus', scriptStep: 3 });
    await states.upsert({ sectorName: 'EdariaBibliothek', npcId: 'quieta', scriptStep: 5 });
    await states.reset('EdariaBibliothek', 'libus');
    expect(await states.find('EdariaBibliothek', 'libus')).toBeUndefined();
    expect((await states.find('EdariaBibliothek', 'quieta'))?.scriptStep).toBe(5);
  });

  it('keeps the same npc id apart per sector', async () => {
    await states.upsert({ sectorName: 'EdariaBibliothek', npcId: 'quieta', scriptStep: 4 });
    await states.upsert({ sectorName: 'EdariaArena', npcId: 'quieta', scriptStep: 6 });
    expect(await states.loadAll('EdariaBibliothek')).toEqual([{ sectorName: 'EdariaBibliothek', npcId: 'quieta', scriptStep: 4 }]);
    expect(await states.loadAll('EdariaArena')).toEqual([{ sectorName: 'EdariaArena', npcId: 'quieta', scriptStep: 6 }]);
  });
});
