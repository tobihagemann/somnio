import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresNPCDialogStateRepository } from '@somnio/data';
import { DialogPruneGuardError, pruneOrphanNPCDialogStates } from '../../src/bootstrap/orphanDialogPrune.ts';
import { makeNPC, makeSector } from '../support/sectorFactory.ts';
import { tempLogging } from '../support/tempLogging.ts';
import { startDatabase } from './support/harness.ts';
import type { DatabaseHarness } from './support/harness.ts';

let harness: DatabaseHarness;

beforeAll(async () => {
  harness = await startDatabase();
});
afterAll(async () => {
  await harness.stop();
});

describe('orphan NPC dialog state prune over Postgres', () => {
  it('keeps valid rows, deletes orphans, and logs the summary', async () => {
    const repo = new PostgresNPCDialogStateRepository(harness.db);
    for (const [sectorName, npcIndex] of [
      ['A', 1],
      ['A', 2],
      ['A', 3],
      ['gone', 1],
    ] as const) {
      await repo.upsert({ sectorName, npcIndex, scriptStep: 1 });
    }
    const logging = tempLogging({ maxBytes: 1 << 20 });
    try {
      const sectors = new Map([['A', makeSector('A', { npcs: [makeNPC({ x: 0, y: 0 }, ''), makeNPC({ x: 64, y: 0 }, '')] })]]);
      await pruneOrphanNPCDialogStates(repo, sectors, false, logging.adminLogger('dialogprune'));
      expect(await repo.find('A', 1)).toBeDefined();
      expect(await repo.find('A', 2)).toBeDefined();
      expect(await repo.find('A', 3)).toBeUndefined();
      expect(await repo.find('gone', 1)).toBeUndefined();
      const summary = logging.stdoutRecords.find((record) => record.includes('prune complete'));
      expect(summary).toContain('"pruned":2');
    } finally {
      logging.cleanup();
    }
  });

  it('the guard aborts the large prune until forced', async () => {
    const repo = new PostgresNPCDialogStateRepository(harness.db);
    for (let index = 1; index <= 40; index += 1) await repo.upsert({ sectorName: 'ghost', npcIndex: index, scriptStep: 1 });
    const logging = tempLogging({ maxBytes: 1 << 20 });
    try {
      await expect(pruneOrphanNPCDialogStates(repo, new Map(), false, logging.adminLogger('dialogprune'))).rejects.toBeInstanceOf(DialogPruneGuardError);
      expect(await repo.find('ghost', 1)).toBeDefined();
      await pruneOrphanNPCDialogStates(repo, new Map(), true, logging.adminLogger('dialogprune'));
      expect(await repo.allKeys()).toEqual([]);
    } finally {
      logging.cleanup();
    }
  });
});
