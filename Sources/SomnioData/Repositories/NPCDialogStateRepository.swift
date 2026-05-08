import Foundation
import Logging
import PostgresNIO
import SomnioCore

public protocol NPCDialogStateRepository: Sendable {
    func find(sectorName: String, npcIndex: Int16) async throws -> NPCDialogState?
    func upsert(_ state: NPCDialogState) async throws
    func reset(sectorName: String, npcIndex: Int16) async throws
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
}

private extension PostgresRow {
    func decodeNPCDialogState() throws -> NPCDialogState {
        let (sectorName, npcIndex, scriptStep) = try decode((String, Int16, Int16).self)
        return NPCDialogState(sectorName: sectorName, npcIndex: npcIndex, scriptStep: scriptStep)
    }
}
