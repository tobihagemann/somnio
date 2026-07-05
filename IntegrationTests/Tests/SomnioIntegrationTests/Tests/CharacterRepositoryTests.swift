import Foundation
import Logging
import PostgresNIO
import SomnioCore
import SomnioData
import Testing

@Suite(.requiresContainerRuntime)
struct CharacterRepositoryTests {
    @Test func `register and load round trips with all energy fields`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.character")
            let accounts = PostgresAccountRepository(client: client, logger: logger)
            let characters = PostgresCharacterRepository(client: client, logger: logger)
            let account = try await accounts.create(name: "alice", passwordHash: "hash", email: "alice@example.com")
            let created = try await characters.create(
                accountId: account.id,
                name: "Alice the Bold",
                figure: 0,
                gender: .female
            )
            let fetched = try #require(try await characters.findByName("Alice the Bold"))
            #expect(fetched.id == created.id)
            #expect(fetched.gender == .female)
            #expect(fetched.currentSector == "EdariaBibliothek")
            #expect(fetched.tempo == .default)
            #expect(fetched.energy.hpCurrent == 100)
            #expect(fetched.energy.hpMax == 100)
            #expect(fetched.energy.balanceCurrent == 100)
            #expect(fetched.energy.balanceMax == 100)
            #expect(fetched.energy.manaCurrent == 100)
            #expect(fetched.energy.manaMax == 100)
        }
    }

    @Test func `create stores a skeleton that rejects a confusable second character`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.character.skeleton")
            let accounts = PostgresAccountRepository(client: client, logger: logger)
            let characters = PostgresCharacterRepository(client: client, logger: logger)
            let accountA = try await accounts.create(name: "owner-a", passwordHash: "h", email: "a@example.com")
            let accountB = try await accounts.create(name: "owner-b", passwordHash: "h", email: "b@example.com")
            _ = try await characters.create(accountId: accountA.id, name: "ADMIN", figure: 0, gender: .male)
            // Cyrillic "АDMIN" is not NFKC-equivalent to Latin "ADMIN" but shares its skeleton, so
            // the `characters_name_skeleton_key` partial unique index must reject it.
            await #expect(throws: PSQLError.self) {
                _ = try await characters.create(accountId: accountB.id, name: "\u{0410}DMIN", figure: 0, gender: .male)
            }
        }
    }

    @Test func `CHECK constraint blocks hp_current greater than hp_max`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.character.check")
            await #expect(throws: PSQLError.self) {
                try await client.query(
                    """
                    INSERT INTO accounts (id, name, password_hash, email)
                    VALUES ('00000000-0000-0000-0000-000000000001'::uuid, 'check-account', 'h', 'c@example.com')
                    """,
                    logger: logger
                )
                try await client.query(
                    """
                    INSERT INTO characters (
                        id, account_id, name, figure, gender,
                        current_sector, position_x, position_y, facing, tempo,
                        hp_current, hp_max, balance_current, balance_max, mana_current, mana_max,
                        last_seen
                    ) VALUES (
                        '00000000-0000-0000-0000-000000000002'::uuid,
                        '00000000-0000-0000-0000-000000000001'::uuid,
                        'overflow', 0, 0,
                        'EdariaBibliothek', 0, 0, 0, 2,
                        100, 50, 100, 100, 100, 100,
                        NOW()
                    )
                    """,
                    logger: logger
                )
            }
        }
    }

    @Test func `snapshot returns false when no row matches the character id`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.character.snapshot.miss")
            let characters = PostgresCharacterRepository(client: client, logger: logger)
            let phantom = Character(
                id: UUID(),
                name: "Phantom",
                figure: 0,
                gender: .female,
                currentSector: "EdariaBibliothek",
                position: GridPoint(x: 0, y: 0),
                facing: Heading(cardinal: .south),
                tempo: .default,
                energy: Energy(hpCurrent: 100, hpMax: 100, balanceCurrent: 100, balanceMax: 100, manaCurrent: 100, manaMax: 100),
                lastSeen: Date()
            )
            let updated = try await characters.snapshot(phantom)
            #expect(updated == false)
        }
    }

    @Test func `snapshot skips the write when last_seen is older than the persisted row`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.character.snapshot.skip-stale")
            let accounts = PostgresAccountRepository(client: client, logger: logger)
            let characters = PostgresCharacterRepository(client: client, logger: logger)
            let account = try await accounts.create(name: "stale-tester", passwordHash: "stub", email: "s@x")
            let original = try await characters.create(accountId: account.id, name: "Stale", figure: 0, gender: .male)

            // First write: bump last_seen to T1.
            var fresh = original
            fresh.position = GridPoint(x: 5, y: 5)
            fresh.lastSeen = original.lastSeen.addingTimeInterval(60)
            let firstUpdated = try await characters.snapshot(fresh)
            #expect(firstUpdated == true)

            // Second write: lastSeen older than T1 must skip and leave the row untouched.
            var stale = original
            stale.position = GridPoint(x: 99, y: 99)
            stale.lastSeen = original.lastSeen
            let secondUpdated = try await characters.snapshot(stale)
            #expect(secondUpdated == false)

            let reloaded = try #require(try await characters.findByName("Stale"))
            #expect(reloaded.position == GridPoint(x: 5, y: 5))
        }
    }

    @Test func `findByName returns nil for an unknown name`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.character.findByName.miss")
            let characters = PostgresCharacterRepository(client: client, logger: logger)
            let fetched = try await characters.findByName("nonexistent")
            #expect(fetched == nil)
        }
    }

    @Test func `findByAccount returns empty for an account with no characters`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.character.findByAccount.empty")
            let accounts = PostgresAccountRepository(client: client, logger: logger)
            let characters = PostgresCharacterRepository(client: client, logger: logger)
            let account = try await accounts.create(name: "alice", passwordHash: "h", email: "a@example.com")
            let fetched = try await characters.findByAccount(account.id)
            #expect(fetched.isEmpty)
        }
    }

    @Test func `decodeCharacter throws on an out-of-range gender raw value`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.character.decode.gender")
            let accounts = PostgresAccountRepository(client: client, logger: logger)
            let account = try await accounts.create(name: "alice", passwordHash: "h", email: "a@example.com")
            // Insert a row by hand with an invalid gender raw value (only 0 or 1 are valid).
            try await client.query(
                """
                INSERT INTO characters (
                    id, account_id, name, figure, gender,
                    current_sector, position_x, position_y, facing, tempo,
                    hp_current, hp_max, balance_current, balance_max, mana_current, mana_max,
                    last_seen
                ) VALUES (
                    \(UUID()), \(account.id), 'WeirdGender', 0, 99,
                    'EdariaBibliothek', 0, 0, 0, 2,
                    100, 100, 100, 100, 100, 100,
                    NOW()
                )
                """,
                logger: logger
            )
            let characters = PostgresCharacterRepository(client: client, logger: logger)
            await #expect(throws: RepositoryDecodingError.self) {
                _ = try await characters.findByName("WeirdGender")
            }
        }
    }

    @Test func `findByAccount returns every character on the account`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.character.list")
            let accounts = PostgresAccountRepository(client: client, logger: logger)
            let characters = PostgresCharacterRepository(client: client, logger: logger)
            let account = try await accounts.create(name: "alice", passwordHash: "hash", email: "alice@example.com")
            _ = try await characters.create(accountId: account.id, name: "Alpha", figure: 0, gender: .female)
            _ = try await characters.create(accountId: account.id, name: "Beta", figure: 1, gender: .male)
            let fetched = try await characters.findByAccount(account.id)
            #expect(fetched.count == 2)
            #expect(Set(fetched.map(\.name)) == ["Alpha", "Beta"])
        }
    }
}
