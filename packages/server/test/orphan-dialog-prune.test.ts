import { describe, expect, it } from 'vitest';
import type { NPCDialogStateKey } from '@somnio/data';
import { DialogPruneGuardError, pruneOrphanNPCDialogStates } from '../src/bootstrap/orphanDialogPrune.ts';
import { npcEntityIndices } from '../src/world/entityIndex.ts';
import { testLogger } from './support/logger.ts';
import { makeNPC, makeSector } from './support/sectorFactory.ts';
import { StubNPCDialogStateRepository } from './support/stubRepositories.ts';

/** A fixed `allKeys()` set that records the `deleteOrphans` argument. */
class RecordingDialogRepository extends StubNPCDialogStateRepository {
  readonly deleted: NPCDialogStateKey[] = [];
  deleteCallCount = 0;
  private readonly stored: NPCDialogStateKey[];

  constructor(stored: NPCDialogStateKey[]) {
    super();
    this.stored = stored;
  }

  override allKeys(): Promise<NPCDialogStateKey[]> {
    return Promise.resolve(this.stored);
  }

  override deleteOrphans(keys: readonly NPCDialogStateKey[]): Promise<void> {
    this.deleteCallCount += 1;
    this.deleted.push(...keys);
    return Promise.resolve();
  }
}

function sectorWithNPCs(name: string, count: number) {
  return makeSector(name, {
    npcs: Array.from({ length: count }, () => makeNPC({ x: 0, y: 0 }, '')),
  });
}

function ghostKeys(count: number): NPCDialogStateKey[] {
  return Array.from({ length: count }, (_, index) => ({ sectorName: 'ghost', npcIndex: index + 1 }));
}

async function guardError(run: () => Promise<void>): Promise<DialogPruneGuardError | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    if (error instanceof DialogPruneGuardError) return error;
    throw error;
  }
}

describe('pruneOrphanNPCDialogStates', () => {
  it('keeps in-range rows and prunes out-of-range, unloaded, and zero-NPC sector rows', async () => {
    const repo = new RecordingDialogRepository([
      { sectorName: 'A', npcIndex: 1 },
      { sectorName: 'A', npcIndex: 2 },
      { sectorName: 'A', npcIndex: 3 },
      { sectorName: 'gone', npcIndex: 1 },
      { sectorName: 'empty', npcIndex: 1 },
    ]);
    const sectors = new Map([
      ['A', sectorWithNPCs('A', 2)],
      ['empty', sectorWithNPCs('empty', 0)],
    ]);
    await pruneOrphanNPCDialogStates(repo, sectors, false, testLogger());
    expect(repo.deleted).toEqual([
      { sectorName: 'A', npcIndex: 3 },
      { sectorName: 'gone', npcIndex: 1 },
      { sectorName: 'empty', npcIndex: 1 },
    ]);
  });

  it('empty table prunes nothing without throwing', async () => {
    const repo = new RecordingDialogRepository([]);
    await pruneOrphanNPCDialogStates(repo, new Map([['A', sectorWithNPCs('A', 2)]]), false, testLogger());
    expect(repo.deleted).toEqual([]);
    expect(repo.deleteCallCount).toBe(1);
  });

  it('guard trips and deletes nothing when orphans exceed the threshold', async () => {
    const repo = new RecordingDialogRepository(ghostKeys(40));
    const error = await guardError(() => pruneOrphanNPCDialogStates(repo, new Map(), false, testLogger()));
    expect(error?.orphanCount).toBe(40);
    expect(error?.totalCount).toBe(40);
    expect(repo.deleteCallCount).toBe(0);
  });

  it('force override proceeds through a large prune', async () => {
    const repo = new RecordingDialogRepository(ghostKeys(40));
    await pruneOrphanNPCDialogStates(repo, new Map(), true, testLogger());
    expect(repo.deleted.length).toBe(40);
  });

  it('absolute floor lets a small all-orphan table prune without tripping', async () => {
    const repo = new RecordingDialogRepository(ghostKeys(19));
    await pruneOrphanNPCDialogStates(repo, new Map(), false, testLogger());
    expect(repo.deleted.length).toBe(19);
  });

  it.each([
    [20, 21, true],
    [21, 20, false],
    [20, 20, true],
    [22, 21, false],
  ])('half-of-total boundary with %i valid and %i orphans trips=%s', async (validCount, orphanCount, expectTrip) => {
    const validKeys = npcEntityIndices(validCount).map((npcIndex) => ({ sectorName: 'valid', npcIndex }));
    const repo = new RecordingDialogRepository([...validKeys, ...ghostKeys(orphanCount)]);
    const sectors = new Map([['valid', sectorWithNPCs('valid', validCount)]]);
    if (expectTrip) {
      const error = await guardError(() => pruneOrphanNPCDialogStates(repo, sectors, false, testLogger()));
      expect(error?.orphanCount).toBe(orphanCount);
      expect(error?.totalCount).toBe(validCount + orphanCount);
      expect(repo.deleteCallCount).toBe(0);
    } else {
      await pruneOrphanNPCDialogStates(repo, sectors, false, testLogger());
      expect(repo.deleted.length).toBe(orphanCount);
    }
  });
});
