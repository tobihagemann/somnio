import Foundation
import Logging
import PostgresNIO
import SomnioCore

public protocol CharacterRepository: Sendable {
    func create(
        accountId: UUID,
        name: String,
        figure: Int16,
        gender: Gender
    ) async throws -> Character
    func findByAccount(_ accountId: UUID) async throws -> [Character]
    func findByName(_ name: String) async throws -> Character?
    func snapshot(_ character: Character) async throws
}

public actor PostgresCharacterRepository: CharacterRepository {
    private let client: PostgresClient
    private let logger: Logger

    public init(client: PostgresClient, logger: Logger) {
        self.client = client
        self.logger = logger
    }

    /// Spawn defaults match the legacy server: starter sector `EdariaBibliothek`, default
    /// tempo, full HP/balance/mana at 100/100. Position defaults to `(0, 0)` — the runtime
    /// re-resolves the spawn point from the sector's portal/header data on first login.
    public func create(
        accountId: UUID,
        name: String,
        figure: Int16,
        gender: Gender
    ) async throws -> Character {
        let id = UUID()
        let lastSeen = Date()
        let character = Character(
            id: id,
            name: name,
            figure: figure,
            gender: gender,
            currentSector: "EdariaBibliothek",
            position: GridPoint(x: 0, y: 0),
            facing: .south,
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
        try await client.query(
            """
            INSERT INTO characters (
                id, account_id, name, figure, gender,
                current_sector, position_x, position_y, facing, tempo,
                hp_current, hp_max, balance_current, balance_max, mana_current, mana_max,
                last_seen
            )
            VALUES (
                \(character.id), \(accountId), \(character.name), \(character.figure), \(character.gender.rawValue),
                \(character.currentSector), \(character.position.x), \(character.position.y),
                \(character.facing.rawValue), \(character.tempo.rawValue),
                \(character.energy.hpCurrent), \(character.energy.hpMax),
                \(character.energy.balanceCurrent), \(character.energy.balanceMax),
                \(character.energy.manaCurrent), \(character.energy.manaMax),
                \(character.lastSeen)
            )
            """,
            logger: logger
        )
        return character
    }

    public func findByAccount(_ accountId: UUID) async throws -> [Character] {
        let rows = try await client.query(
            """
            SELECT
                id, name, figure, gender,
                current_sector, position_x, position_y, facing, tempo,
                hp_current, hp_max, balance_current, balance_max, mana_current, mana_max,
                last_seen
            FROM characters
            WHERE account_id = \(accountId)
            ORDER BY name
            """,
            logger: logger
        )
        var characters: [Character] = []
        for try await row in rows {
            try characters.append(row.decodeCharacter())
        }
        return characters
    }

    /// Looks up via the `name_normalized` generated column so case- and Unicode-confusable
    /// variants of the registered name resolve to the same character.
    public func findByName(_ name: String) async throws -> Character? {
        let rows = try await client.query(
            """
            SELECT
                id, name, figure, gender,
                current_sector, position_x, position_y, facing, tempo,
                hp_current, hp_max, balance_current, balance_max, mana_current, mana_max,
                last_seen
            FROM characters
            WHERE name_normalized = LOWER(NORMALIZE(\(name), NFKC))
            """,
            logger: logger
        )
        for try await row in rows {
            return try row.decodeCharacter()
        }
        return nil
    }

    /// Persists `character` over an existing row. Throws `RepositoryError.noSuchCharacter`
    /// when no row matches `character.id` so a missing/deleted character can't silently
    /// drop a logout/checkpoint snapshot. We use `UPDATE ... RETURNING id` because
    /// PostgresNIO doesn't surface command-tag affected-row counts for plain `UPDATE`.
    public func snapshot(_ character: Character) async throws {
        let rows = try await client.query(
            """
            UPDATE characters SET
                figure = \(character.figure),
                gender = \(character.gender.rawValue),
                current_sector = \(character.currentSector),
                position_x = \(character.position.x),
                position_y = \(character.position.y),
                facing = \(character.facing.rawValue),
                tempo = \(character.tempo.rawValue),
                hp_current = \(character.energy.hpCurrent),
                hp_max = \(character.energy.hpMax),
                balance_current = \(character.energy.balanceCurrent),
                balance_max = \(character.energy.balanceMax),
                mana_current = \(character.energy.manaCurrent),
                mana_max = \(character.energy.manaMax),
                last_seen = \(character.lastSeen)
            WHERE id = \(character.id)
            RETURNING id
            """,
            logger: logger
        )
        var affected = 0
        for try await _ in rows {
            affected += 1
        }
        guard affected > 0 else {
            throw RepositoryError.noSuchCharacter(id: character.id)
        }
    }
}

private extension PostgresRow {
    func decodeCharacter() throws -> Character {
        let (
            id, name, figure, genderRaw,
            currentSector, positionX, positionY, facingRaw, tempoRaw,
            hpCurrent, hpMax, balanceCurrent, balanceMax, manaCurrent, manaMax,
            lastSeen
        ) = try decode(
            (
                UUID, String, Int16, Int16,
                String, Int16, Int16, Int16, Int16,
                Int16, Int16, Int16, Int16, Int16, Int16,
                Date
            ).self
        )
        guard let gender = Gender(rawValue: genderRaw) else {
            throw RepositoryDecodingError.invalidEnumRawValue(field: "gender", rawValue: Int(genderRaw))
        }
        guard let facing = Direction(rawValue: facingRaw) else {
            throw RepositoryDecodingError.invalidEnumRawValue(field: "facing", rawValue: Int(facingRaw))
        }
        guard let tempo = Tempo(rawValue: tempoRaw) else {
            throw RepositoryDecodingError.invalidEnumRawValue(field: "tempo", rawValue: Int(tempoRaw))
        }
        return Character(
            id: id,
            name: name,
            figure: figure,
            gender: gender,
            currentSector: currentSector,
            position: GridPoint(x: positionX, y: positionY),
            facing: facing,
            tempo: tempo,
            energy: Energy(
                hpCurrent: hpCurrent,
                hpMax: hpMax,
                balanceCurrent: balanceCurrent,
                balanceMax: balanceMax,
                manaCurrent: manaCurrent,
                manaMax: manaMax
            ),
            lastSeen: lastSeen
        )
    }
}
