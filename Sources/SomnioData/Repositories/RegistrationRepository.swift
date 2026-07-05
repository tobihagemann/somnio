import Foundation
import Logging
import PostgresNIO
import SomnioCore

/// Errors specific to registration flow. Surfaced from the unique-name constraint race so the
/// caller can map to a typed `RegisterResultCode` without parsing SQLSTATE strings.
public enum RegistrationError: Error, Sendable, Equatable {
    case nicknameTaken
}

/// Atomic provisioning of `(Account, Character, [InventoryRow])` in a single Postgres
/// transaction so a partial registration never lands. Account/character `name_normalized`
/// columns are populated by the GENERATED ALWAYS migration definitions and must be omitted
/// from the INSERT column list.
public protocol RegistrationRepository: Sendable {
    // swiftlint:disable:next function_parameter_count
    func register(
        name: String,
        passwordHash: String,
        email: String,
        gender: Gender,
        figure: Int16,
        starterInventory: [InventoryRow]
    ) async throws -> (Account, Character)
}

public actor PostgresRegistrationRepository: RegistrationRepository {
    private let client: PostgresClient
    private let logger: Logger

    public init(client: PostgresClient, logger: Logger) {
        self.client = client
        self.logger = logger
    }

    // swiftlint:disable:next function_body_length function_parameter_count
    public func register(
        name: String,
        passwordHash: String,
        email: String,
        gender: Gender,
        figure: Int16,
        starterInventory: [InventoryRow]
    ) async throws -> (Account, Character) {
        let accountId = UUID()
        let characterId = UUID()
        let createdAt = Date()
        let lastSeen = createdAt
        let logger = logger
        let skeleton = NamePolicy.confusableSkeleton(name)
        let skeletonVersion = Int32(NamePolicy.skeletonAlgorithmVersion)
        let character = Character(
            id: characterId,
            name: name,
            figure: figure,
            gender: gender,
            currentSector: starterSector,
            position: GridPoint(x: 0, y: 0),
            facing: Heading(cardinal: .south),
            tempo: .default,
            energy: Energy(
                hpCurrent: 100,
                hpMax: 100,
                balanceCurrent: 100,
                balanceMax: 100,
                manaCurrent: 100,
                manaMax: 100
            ),
            lastSeen: lastSeen
        )
        let account = Account(
            id: accountId,
            name: name,
            passwordHash: passwordHash,
            email: email,
            createdAt: createdAt
        )
        do {
            try await client.withTransaction(logger: logger) { connection in
                try await connection.query(
                    """
                    INSERT INTO accounts (id, name, password_hash, email, created_at, name_skeleton, name_skeleton_version)
                    VALUES (\(accountId), \(name), \(passwordHash), \(email), \(createdAt), \(skeleton), \(skeletonVersion))
                    """,
                    logger: logger
                )
                try await connection.query(
                    """
                    INSERT INTO characters (
                        id, account_id, name, figure, gender,
                        current_sector, position_x, position_y, facing, tempo,
                        hp_current, hp_max, balance_current, balance_max, mana_current, mana_max,
                        last_seen, name_skeleton, name_skeleton_version
                    )
                    VALUES (
                        \(character.id), \(accountId), \(character.name), \(character.figure), \(character.gender.rawValue),
                        \(character.currentSector), \(character.position.x), \(character.position.y),
                        \(character.facing.degrees), \(character.tempo.rawValue),
                        \(character.energy.hpCurrent), \(character.energy.hpMax),
                        \(character.energy.balanceCurrent), \(character.energy.balanceMax),
                        \(character.energy.manaCurrent), \(character.energy.manaMax),
                        \(character.lastSeen), \(skeleton), \(skeletonVersion)
                    )
                    """,
                    logger: logger
                )
                for row in starterInventory {
                    let extras = InventoryExtrasJSONB(values: row.extras)
                    let equippedHandRaw: Int16? = row.equippedHand?.rawValue
                    try await connection.query(
                        """
                        INSERT INTO inventory_rows (character_id, slot, category, item_id, extras, equipped_hand)
                        VALUES (
                            \(character.id),
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
        } catch {
            if isNameUniqueViolation(error) {
                throw RegistrationError.nicknameTaken
            }
            throw error
        }
        return (account, character)
    }

    /// Starter sector matches the legacy game's spawn point for new accounts.
    private let starterSector: String = "EdariaBibliothek"

    /// PostgreSQL auto-names unnamed inline `UNIQUE` constraints and `CREATE UNIQUE INDEX` indexes
    /// `<table>_<column>_key`. Matching the literal names keeps the error mapping precise: a future
    /// schema addition with another UNIQUE column won't silently get folded into `nicknameTaken`.
    /// Mapping every name-uniqueness constraint (normalized + skeleton, both tables) keeps the mapping
    /// correct regardless of which one the DB reports first.
    private let nameUniqueConstraints: Set<String> = [
        "accounts_name_normalized_key",
        "accounts_name_skeleton_key",
        "characters_name_normalized_key",
        "characters_name_skeleton_key"
    ]

    private func isNameUniqueViolation(_ error: any Error) -> Bool {
        let underlyingError: any Error = if let transactionError = error as? PostgresTransactionError, let closureError = transactionError.closureError {
            closureError
        } else {
            error
        }
        guard let psqlError = underlyingError as? PSQLError else { return false }
        guard psqlError.serverInfo?[.sqlState] == "23505" else { return false }
        guard let constraint = psqlError.serverInfo?[.constraintName] else { return false }
        return nameUniqueConstraints.contains(constraint)
    }
}
