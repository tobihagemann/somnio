import Foundation
import Logging
import PostgresNIO
import SomnioCore

public protocol InventoryRepository: Sendable {
    func loadAll(forCharacter characterId: UUID) async throws -> [InventoryRow]
    func replaceAll(forCharacter characterId: UUID, rows: [InventoryRow]) async throws
}

public actor PostgresInventoryRepository: InventoryRepository {
    private let client: PostgresClient
    private let logger: Logger

    public init(client: PostgresClient, logger: Logger) {
        self.client = client
        self.logger = logger
    }

    public func loadAll(forCharacter characterId: UUID) async throws -> [InventoryRow] {
        let rows = try await client.query(
            """
            SELECT slot, category, item_id, extras, equipped_hand
            FROM inventory_rows
            WHERE character_id = \(characterId)
            ORDER BY slot
            """,
            logger: logger
        )
        var result: [InventoryRow] = []
        for try await row in rows {
            try result.append(row.decodeInventoryRow())
        }
        return result
    }

    public func replaceAll(forCharacter characterId: UUID, rows: [InventoryRow]) async throws {
        try await client.withTransaction(logger: logger) { connection in
            try await connection.query(
                "DELETE FROM inventory_rows WHERE character_id = \(characterId)",
                logger: self.logger
            )
            for row in rows {
                try await Self.insertRow(row, characterId: characterId, connection: connection, logger: self.logger)
            }
        }
    }

    private static func insertRow(
        _ row: InventoryRow,
        characterId: UUID,
        connection: PostgresConnection,
        logger: Logger
    ) async throws {
        let extras = InventoryExtrasJSONB(values: row.extras)
        let equippedHandRaw: Int16? = row.equippedHand?.rawValue
        try await connection.query(
            """
            INSERT INTO inventory_rows (character_id, slot, category, item_id, extras, equipped_hand)
            VALUES (
                \(characterId),
                \(row.slot),
                \(row.category),
                \(row.itemId),
                \(extras),
                \(equippedHandRaw)
            )
            """,
            logger: logger
        )
    }
}

private extension PostgresRow {
    func decodeInventoryRow() throws -> InventoryRow {
        let (slot, category, itemId, extras, equippedHandRaw) = try decode(
            (Int16, Int16, Int16, InventoryExtrasJSONB, Int16?).self
        )
        let equippedHand: Hand?
        if let raw = equippedHandRaw {
            guard let value = Hand(rawValue: raw) else {
                throw RepositoryDecodingError.invalidEnumRawValue(field: "equipped_hand", rawValue: Int(raw))
            }
            equippedHand = value
        } else {
            equippedHand = nil
        }
        return InventoryRow(
            slot: slot,
            category: category,
            itemId: itemId,
            extras: extras.values,
            equippedHand: equippedHand
        )
    }
}

/// Single-value JSONB carrier for the ordered `[InventoryExtra]` list. The custom
/// `Codable` impl keeps the stored shape as a bare JSON array (not `{"values": [...]}`),
/// matching the column comment authored in migration 3.
private struct InventoryExtrasJSONB: Codable {
    let values: [InventoryExtra]

    init(values: [InventoryExtra]) {
        self.values = values
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        self.values = try container.decode([InventoryExtra].self)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(values)
    }
}

extension InventoryExtrasJSONB: PostgresEncodable, PostgresDecodable {}
