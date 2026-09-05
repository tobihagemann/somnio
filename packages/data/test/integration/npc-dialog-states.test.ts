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
    await states.upsert({ sectorName: 'EdariaBibliothek', npcIndex: 0, scriptStep: 1 });
    await states.upsert({ sectorName: 'EdariaBibliothek', npcIndex: 0, scriptStep: 2 });
    expect((await states.find('EdariaBibliothek', 0))?.scriptStep).toBe(2);
  });

  it('resets only the targeted row', async () => {
    await states.upsert({ sectorName: 'EdariaBibliothek', npcIndex: 0, scriptStep: 3 });
    await states.upsert({ sectorName: 'EdariaBibliothek', npcIndex: 1, scriptStep: 5 });
    await states.reset('EdariaBibliothek', 0);
    expect(await states.find('EdariaBibliothek', 0)).toBeUndefined();
    expect((await states.find('EdariaBibliothek', 1))?.scriptStep).toBe(5);
  });

  it('deletes only the listed orphans and no-ops on empty input', async () => {
    await states.upsert({ sectorName: 'EdariaBibliothek', npcIndex: 0, scriptStep: 2 });
    await states.upsert({ sectorName: 'EdariaBibliothek', npcIndex: 1, scriptStep: 4 });
    await states.upsert({ sectorName: 'EdariaArena', npcIndex: 0, scriptStep: 6 });
    await states.deleteOrphans([]);
    expect((await states.allKeys()).sort((a, b) => a.sectorName.localeCompare(b.sectorName) || a.npcIndex - b.npcIndex)).toEqual([
      { sectorName: 'EdariaArena', npcIndex: 0 },
      { sectorName: 'EdariaBibliothek', npcIndex: 0 },
      { sectorName: 'EdariaBibliothek', npcIndex: 1 },
    ]);
    await states.deleteOrphans([
      { sectorName: 'EdariaBibliothek', npcIndex: 0 },
      { sectorName: 'EdariaArena', npcIndex: 0 },
    ]);
    expect(await states.find('EdariaBibliothek', 0)).toBeUndefined();
    expect(await states.find('EdariaArena', 0)).toBeUndefined();
    expect((await states.find('EdariaBibliothek', 1))?.scriptStep).toBe(4);
    expect(await states.loadAll('EdariaBibliothek')).toEqual([{ sectorName: 'EdariaBibliothek', npcIndex: 1, scriptStep: 4 }]);
  });
});
