import type { NPCDialogState } from '@somnio/core';
import type { NPCDialogStateRepository } from '@somnio/data';
import type { Logger } from '../logging.ts';
import type { TickDigest } from './spaceActor.ts';

/** A write of one NPC's dialog row: its cursor, or the row's deletion. */
type DialogWrite = { kind: 'upsert'; state: NPCDialogState } | { kind: 'reset'; sectorName: string; npcId: string };

/**
 * The NPC dialog writes the simulation asks for, one in flight at a time and never awaited by a
 * pass, so a stalled database holds no pass. Only an NPC's latest write matters, so a write not yet
 * started waits keyed by `<sector>/<npc>`, and a later one for the same NPC replaces it. A digest's
 * resets are queued after its upserts, so a reset wins over an upsert of the same NPC.
 */
export class DialogWrites {
  private readonly pending = new Map<string, DialogWrite>();
  private readonly npcDialogStates: NPCDialogStateRepository;
  private readonly logger: Logger;
  /** Settles once the writes queued so far are written; none while nothing is queued. */
  private writer: Promise<void> | undefined;

  constructor(npcDialogStates: NPCDialogStateRepository, logger: Logger) {
    this.npcDialogStates = npcDialogStates;
    this.logger = logger;
  }

  /** Queues the digest's writes behind the one in flight. */
  request(digest: TickDigest): void {
    for (const state of digest.dialogUpserts) this.pending.set(`${state.sectorName}/${state.npcId}`, { kind: 'upsert', state });
    for (const { sectorName, npcId } of digest.dialogResets) this.pending.set(`${sectorName}/${npcId}`, { kind: 'reset', sectorName, npcId });
    if (this.writer === undefined && this.pending.size > 0) this.writer = this.drain();
  }

  /** Resolves once every write queued so far has settled. */
  settle(): Promise<void> {
    return this.writer ?? Promise.resolve();
  }

  /** Writes the queued writes, oldest first, until none is left. A failure logs and continues (the next emit rewrites the row). */
  private async drain(): Promise<void> {
    while (this.pending.size > 0) {
      const [key, write] = this.pending.entries().next().value!;
      this.pending.delete(key);
      try {
        if (write.kind === 'upsert') await this.npcDialogStates.upsert(write.state);
        else await this.npcDialogStates.reset(write.sectorName, write.npcId);
      } catch (error) {
        const { sectorName, npcId } = write.kind === 'upsert' ? write.state : write;
        this.logger.warn({ error: String(error), sector: sectorName, npc: npcId }, `npc dialog ${write.kind} failed`);
      }
    }
    this.writer = undefined;
  }
}
