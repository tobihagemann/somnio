import type { CharacterRepository } from '@somnio/data'
import type { Logger } from '../logging.ts'
import type { PlayerCheckpoint } from './perSectorActor.ts'

/**
 * Writes a checkpoint through `persistCheckpoint`'s single transaction, so a periodic pass racing
 * a disconnect snapshot for the same character has either both writes accepted or both skipped
 * by the `last_seen` guard — never one transaction's character row beside another's inventory.
 */
export async function persistPlayerCheckpoint(
  snapshot: PlayerCheckpoint,
  characters: CharacterRepository,
  logger: Logger,
  context: Record<string, string> = {}
): Promise<void> {
  try {
    await characters.persistCheckpoint(snapshot.character, snapshot.inventory)
  } catch (error) {
    logger.error(
      { error: String(error), character_id: snapshot.character.id, ...context },
      'failed to persist player snapshot'
    )
  }
}
