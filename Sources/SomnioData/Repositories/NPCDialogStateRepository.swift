import Foundation
import Logging
import PostgresNIO
import SomnioCore

/// Composite primary key `(sector_name, npc_index)` of an `npc_dialog_states` row. The orphan
/// prune operates on a `Set` of these to diff stored rows against the loaded sectors' valid
/// NPC indices.
public struct NPCDialogStateKey: Hashable, Sendable {
    public let sectorName: String
    public let npcIndex: Int16

    public init(sectorName: String, npcIndex: Int16) {
        self.sectorName = sectorName
        self.npcIndex = npcIndex
    }
}

public protocol NPCDialogStateRepository: Sendable {
    func find(sectorName: String, npcIndex: Int16) async throws -> NPCDialogState?
    func loadAll(sectorName: String) async throws -> [NPCDialogState]
    func allKeys() async throws -> [NPCDialogStateKey]
    func upsert(_ state: NPCDialogState) async throws
    func reset(sectorName: String, npcIndex: Int16) async throws
    func deleteOrphans(_ keys: [NPCDialogStateKey]) async throws
}

public actor PostgresNPCDialogStateRepository: NPCDialogStateRepository {
    private let client: PostgresClient
    private let logger: Logger

    public init(client: PostgresClient, logger: Logger) {
        self.client = client
        self.logger = logger
    }

    public func find(sectorName: String, npcIndex: Int16) async throws -> NPCDialogState? {
        let rows = try await client.query(
            """
            SELECT sector_name, npc_index, script_step
            FROM npc_dialog_states
            WHERE sector_name = \(sectorName) AND npc_index = \(npcIndex)
            """,
            logger: logger
        )
        for try await row in rows {
            return try row.decodeNPCDialogState()
        }
        return nil
    }

    public func loadAll(sectorName: String) async throws -> [NPCDialogState] {
        let rows = try await client.query(
            """
            SELECT sector_name, npc_index, script_step
            FROM npc_dialog_states
            WHERE sector_name = \(sectorName)
            """,
            logger: logger
        )
        var states: [NPCDialogState] = []
        for try await row in rows {
            try states.append(row.decodeNPCDialogState())
        }
        return states
    }

    public func allKeys() async throws -> [NPCDialogStateKey] {
        let rows = try await client.query(
            """
            SELECT sector_name, npc_index
            FROM npc_dialog_states
            """,
            logger: logger
        )
        var keys: [NPCDialogStateKey] = []
        for try await row in rows {
            try keys.append(row.decodeNPCDialogStateKey())
        }
        return keys
    }

    public func upsert(_ state: NPCDialogState) async throws {
        try await client.query(
            """
            INSERT INTO npc_dialog_states (sector_name, npc_index, script_step)
            VALUES (\(state.sectorName), \(state.npcIndex), \(state.scriptStep))
            ON CONFLICT (sector_name, npc_index) DO UPDATE SET
                script_step = EXCLUDED.script_step
            """,
            logger: logger
        )
    }

    public func reset(sectorName: String, npcIndex: Int16) async throws {
        try await client.query(
            """
            DELETE FROM npc_dialog_states
            WHERE sector_name = \(sectorName) AND npc_index = \(npcIndex)
            """,
            logger: logger
        )
    }

    public func deleteOrphans(_ keys: [NPCDialogStateKey]) async throws {
        guard !keys.isEmpty else { return }
        // Per-key DELETE inside one transaction — the codebase has no set-based / array-bound
        // DELETE idiom (see `NameSkeletonBackfill.updateBatch`), so this mirrors the per-row loop
        // rather than introducing an `= ANY` binding.
        try await client.withTransaction(logger: logger) { connection in
            for key in keys {
                try await connection.query(
                    """
                    DELETE FROM npc_dialog_states
                    WHERE sector_name = \(key.sectorName) AND npc_index = \(key.npcIndex)
                    """,
                    logger: logger
                )
            }
        }
    }
}

private extension PostgresRow {
    func decodeNPCDialogState() throws -> NPCDialogState {
        let (sectorName, npcIndex, scriptStep) = try decode((String, Int16, Int16).self)
        return NPCDialogState(sectorName: sectorName, npcIndex: npcIndex, scriptStep: scriptStep)
    }

    func decodeNPCDialogStateKey() throws -> NPCDialogStateKey {
        let (sectorName, npcIndex) = try decode((String, Int16).self)
        return NPCDialogStateKey(sectorName: sectorName, npcIndex: npcIndex)
    }
}
