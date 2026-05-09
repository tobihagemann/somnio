import Foundation
import Logging
import SomnioData

/// Writes a `PlayerCheckpoint` (full character + inventory) through `CharacterRepository`'s
/// atomic `persistCheckpoint(character:inventory:)`. Used by both the periodic
/// `WorldRouter.checkpointAll` pass and the per-disconnect snapshot in `ConnectionActor`.
/// The single-transaction write ensures the character row and the inventory rows can't
/// land out-of-order: a periodic pass that races a per-disconnect snapshot for the same
/// character has either both writes accepted or both writes skipped via the `last_seen`
/// guard, never a mixed state where one transaction's character row sits next to another
/// transaction's inventory rows.
enum PlayerCheckpointWriter {
    static func persist(
        _ snapshot: PlayerCheckpoint,
        characters: any CharacterRepository,
        logger: Logger,
        context: Logger.Metadata = [:]
    ) async {
        do {
            try await characters.persistCheckpoint(
                character: snapshot.character,
                inventory: snapshot.inventory
            )
        } catch {
            var metadata: Logger.Metadata = ["error": "\(error)", "character_id": "\(snapshot.character.id)"]
            for (key, value) in context {
                metadata[key] = value
            }
            logger.error("failed to persist player snapshot", metadata: metadata)
        }
    }
}
