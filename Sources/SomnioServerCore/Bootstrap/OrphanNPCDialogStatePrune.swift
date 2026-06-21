import Foundation
import Logging
import SomnioCore
import SomnioData

/// One-time boot reconciliation that prunes orphan `npc_dialog_states` rows — rows whose
/// `(sector_name, npc_index)` no longer maps to a live NPC in the loaded sector set. They
/// accumulate after a sector edit removes/reorders NPCs or a sector file leaves
/// `SOMNIO_SECTORS_DIR`, and a future NPC reusing the same index would otherwise inherit a stale
/// dialog cursor. Mirrors `NameSkeletonBackfill`'s shape: a `public struct` with an async
/// entrypoint, run on the readiness path so a throw triggers graceful shutdown.
///
/// The prune runs unconditionally (a reset cursor just restarts a dialog script) but is protected
/// by a **bounded guard**: when it would delete both a non-trivial *and* majority share of the
/// table, boot aborts rather than silently wiping cursors. This guards the one realistic footgun —
/// an operator booting a partial `SOMNIO_SECTORS_DIR` against the production DB, which would orphan
/// every other sector's cursors. The guard is overridable for one boot via `SOMNIO_DIALOG_PRUNE_FORCE`
/// (threaded in as `allowLargePrune`), so no permanent config flag is introduced.
public struct OrphanNPCDialogStatePrune {
    /// Minimum orphan count below which the guard never trips, so a normal sector edit (a handful of
    /// orphans) prunes freely while a partial-dir boot (most rows orphaned) aborts. The floor and the
    /// half-of-total rule below are tunable.
    static let absoluteFloor = 20

    private let npcDialogStates: any NPCDialogStateRepository
    private let logger: Logger

    public init(npcDialogStates: any NPCDialogStateRepository, logger: Logger) {
        self.npcDialogStates = npcDialogStates
        self.logger = logger
    }

    public func prune(loadedSectors: [String: Sector], allowLargePrune: Bool) async throws {
        var validKeys: Set<NPCDialogStateKey> = []
        for (name, sector) in loadedSectors {
            for index in PerSectorActor.npcEntityIndices(count: sector.npcs.count) {
                validKeys.insert(NPCDialogStateKey(sectorName: name, npcIndex: index))
            }
        }

        let stored = try await npcDialogStates.allKeys()
        let orphans = stored.filter { !validKeys.contains($0) }

        // Integer-only comparison (orphans*2 >= total) so a boundary like 21/41 trips cleanly instead
        // of fail-open float rounding: orphans are at least the floor *and* at least half the table.
        if !allowLargePrune, orphans.count >= Self.absoluteFloor, orphans.count * 2 >= stored.count {
            logger.error(
                "orphan npc dialog state prune aborted by safety guard",
                metadata: [
                    "orphans": "\(orphans.count)",
                    "total": "\(stored.count)",
                    "override": "set SOMNIO_DIALOG_PRUNE_FORCE=1 to force"
                ]
            )
            throw ServerStartupError.dialogPruneGuardTripped(orphanCount: orphans.count, totalCount: stored.count)
        }

        try await npcDialogStates.deleteOrphans(orphans)
        logger.info(
            "orphan npc dialog state prune complete",
            metadata: [
                "pruned": "\(orphans.count)",
                "total": "\(stored.count)",
                "sectors": "\(loadedSectors.count)"
            ]
        )
    }
}
