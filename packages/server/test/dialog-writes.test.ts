import { describe, expect, it } from 'vitest';
import type { NPCDialogState } from '@somnio/core';
import { DialogWrites } from '../src/world/dialogWrites.ts';
import { recordingLogger } from './support/logger.ts';
import { StubNPCDialogStateRepository } from './support/stubRepositories.ts';

describe('DialogWrites', () => {
  it('logs a failed write and goes on to the ones queued behind it', async () => {
    const written: string[] = [];
    class FailingFirst extends StubNPCDialogStateRepository {
      override upsert(state: NPCDialogState): Promise<void> {
        if (state.npcId === 'first') return Promise.reject(new Error('database down'));
        written.push(state.npcId);
        return Promise.resolve();
      }
    }
    const { logger, records } = recordingLogger();
    const writes = new DialogWrites(new FailingFirst(), logger);
    writes.request({
      dialogUpserts: [
        { sectorName: 'A', npcId: 'first', scriptStep: 1 },
        { sectorName: 'A', npcId: 'second', scriptStep: 2 },
      ],
      dialogResets: [],
    });
    await writes.settle();
    expect(written).toEqual(['second']);
    expect(records.filter((record) => record['msg'] === 'npc dialog upsert failed')).toMatchObject([{ sector: 'A', npc: 'first' }]);
  });
});
