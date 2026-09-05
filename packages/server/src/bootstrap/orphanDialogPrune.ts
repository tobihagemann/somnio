import type { Sector } from '@somnio/core'
import type { NPCDialogStateRepository } from '@somnio/data'
import type { Logger } from '../logging.ts'
import { npcEntityIndices } from '../world/entityIndex.ts'

/** Minimum orphan count below which the guard never trips, so a normal sector edit prunes freely. */
export const PRUNE_ABSOLUTE_FLOOR = 20

export class DialogPruneGuardError extends Error {
  readonly orphanCount: number
  readonly totalCount: number

  constructor(orphanCount: number, totalCount: number) {
    super(
      `orphan npc_dialog_states prune aborted: ${orphanCount} of ${totalCount} rows would be deleted, which ` +
        'exceeds the safety guard. This usually means SOMNIO_SECTORS_DIR is partial relative to the database. ' +
        'If the large prune is intentional, re-run once with SOMNIO_DIALOG_PRUNE_FORCE=1'
    )
    this.name = 'DialogPruneGuardError'
    this.orphanCount = orphanCount
    this.totalCount = totalCount
  }
}

/**
 * Prunes `npc_dialog_states` rows whose `(sector, npc index)` no longer maps to a live NPC. The
 * bounded guard aborts boot when the prune would delete at least 20 rows and at least half the
 * table — the partial-`SOMNIO_SECTORS_DIR`-against-production footgun — unless the one-shot
 * force override is set.
 */
export async function pruneOrphanNPCDialogStates(
  npcDialogStates: NPCDialogStateRepository,
  loadedSectors: ReadonlyMap<string, Sector>,
  allowLargePrune: boolean,
  logger: Logger
): Promise<void> {
  const validKeys = new Set<string>()
  for (const [name, sector] of loadedSectors) {
    for (const index of npcEntityIndices(sector.npcs.length)) validKeys.add(`${name} ${index}`)
  }
  const stored = await npcDialogStates.allKeys()
  const orphans = stored.filter((key) => !validKeys.has(`${key.sectorName} ${key.npcIndex}`))
  if (!allowLargePrune && orphans.length >= PRUNE_ABSOLUTE_FLOOR && orphans.length * 2 >= stored.length) {
    logger.error(
      { orphans: orphans.length, total: stored.length, override: 'set SOMNIO_DIALOG_PRUNE_FORCE=1 to force' },
      'orphan npc dialog state prune aborted by safety guard'
    )
    throw new DialogPruneGuardError(orphans.length, stored.length)
  }
  await npcDialogStates.deleteOrphans(orphans)
  logger.info({ pruned: orphans.length, total: stored.length }, 'orphan npc dialog state prune complete')
}
