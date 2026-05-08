import Logging
import PostgresNIO
import SomnioCore
import SomnioData
import Testing

@Suite(.requiresContainerRuntime)
struct InventoryRepositoryTests {
    @Test func `replace all then load preserves rows and ordered extras`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.inventory")
            let accounts = PostgresAccountRepository(client: client, logger: logger)
            let characters = PostgresCharacterRepository(client: client, logger: logger)
            let inventory = PostgresInventoryRepository(client: client, logger: logger)
            let account = try await accounts.create(name: "alice", passwordHash: "h", email: "a@example.com")
            let character = try await characters.create(accountId: account.id, name: "Alice", figure: 0, gender: .female)

            let purse = InventoryRow(
                slot: 0,
                category: 0,
                itemId: 0,
                extras: [InventoryExtra(key: "gold", value: 100), InventoryExtra(key: "silver", value: 5)],
                equippedHand: nil
            )
            let cudgel = InventoryRow(slot: 1, category: 1, itemId: 0, extras: [], equippedHand: .right)
            try await inventory.replaceAll(forCharacter: character.id, rows: [purse, cudgel])

            let loaded = try await inventory.loadAll(forCharacter: character.id)
            #expect(loaded == [purse, cudgel])
            #expect(loaded[0].extras.map(\.key) == ["gold", "silver"])
        }
    }

    @Test func `equipped hand round trips left right and nil`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.inventory.hand")
            let accounts = PostgresAccountRepository(client: client, logger: logger)
            let characters = PostgresCharacterRepository(client: client, logger: logger)
            let inventory = PostgresInventoryRepository(client: client, logger: logger)
            let account = try await accounts.create(name: "alice", passwordHash: "h", email: "a@example.com")
            let character = try await characters.create(accountId: account.id, name: "Alice", figure: 0, gender: .female)

            let rows = [
                InventoryRow(slot: 0, category: 1, itemId: 0, extras: [], equippedHand: .left),
                InventoryRow(slot: 1, category: 1, itemId: 0, extras: [], equippedHand: .right),
                InventoryRow(slot: 2, category: 1, itemId: 0, extras: [], equippedHand: nil)
            ]
            try await inventory.replaceAll(forCharacter: character.id, rows: rows)
            let loaded = try await inventory.loadAll(forCharacter: character.id)
            #expect(loaded.map(\.equippedHand) == [.left, .right, nil])
        }
    }

    @Test func `replace all rolls back when a row in the batch fails`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.inventory.rollback")
            let accounts = PostgresAccountRepository(client: client, logger: logger)
            let characters = PostgresCharacterRepository(client: client, logger: logger)
            let inventory = PostgresInventoryRepository(client: client, logger: logger)
            let account = try await accounts.create(name: "alice", passwordHash: "h", email: "a@example.com")
            let character = try await characters.create(accountId: account.id, name: "Alice", figure: 0, gender: .female)

            let initial = [
                InventoryRow(slot: 0, category: 0, itemId: 0, extras: [InventoryExtra(key: "gold", value: 100)])
            ]
            try await inventory.replaceAll(forCharacter: character.id, rows: initial)

            // Two rows with the same `slot` violate the (character_id, slot) primary key.
            // The transaction must roll back the leading DELETE so the original row survives.
            let conflicting = [
                InventoryRow(slot: 0, category: 1, itemId: 0),
                InventoryRow(slot: 0, category: 2, itemId: 1)
            ]
            // `withTransaction` wraps the inner failure in PostgresTransactionError; we
            // assert via type-erased Error and inspect the rollback effect below.
            await #expect(throws: (any Error).self) {
                try await inventory.replaceAll(forCharacter: character.id, rows: conflicting)
            }

            let surviving = try await inventory.loadAll(forCharacter: character.id)
            #expect(surviving == initial)
        }
    }

    @Test func `decodeInventoryRow throws on out-of-range equipped_hand`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.inventory.decode.hand")
            let accounts = PostgresAccountRepository(client: client, logger: logger)
            let characters = PostgresCharacterRepository(client: client, logger: logger)
            let inventory = PostgresInventoryRepository(client: client, logger: logger)
            let account = try await accounts.create(name: "alice", passwordHash: "h", email: "a@example.com")
            let character = try await characters.create(accountId: account.id, name: "Alice", figure: 0, gender: .female)
            // The CHECK constraint blocks raw INSERTs with `equipped_hand IN (0, 1)` only,
            // so we deliberately pick a value that survives the constraint by dropping it
            // first.
            try await client.query(
                "ALTER TABLE inventory_rows DROP CONSTRAINT inventory_rows_equipped_hand_check",
                logger: logger
            )
            try await client.query(
                """
                INSERT INTO inventory_rows (character_id, slot, category, item_id, extras, equipped_hand)
                VALUES (\(character.id), 0, 1, 0, '[]'::jsonb, 5)
                """,
                logger: logger
            )
            await #expect(throws: RepositoryDecodingError.self) {
                _ = try await inventory.loadAll(forCharacter: character.id)
            }
        }
    }

    @Test func `replace all clears existing rows`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.inventory.clear")
            let accounts = PostgresAccountRepository(client: client, logger: logger)
            let characters = PostgresCharacterRepository(client: client, logger: logger)
            let inventory = PostgresInventoryRepository(client: client, logger: logger)
            let account = try await accounts.create(name: "alice", passwordHash: "h", email: "a@example.com")
            let character = try await characters.create(accountId: account.id, name: "Alice", figure: 0, gender: .female)

            try await inventory.replaceAll(
                forCharacter: character.id,
                rows: [InventoryRow(slot: 0, category: 0, itemId: 0)]
            )
            try await inventory.replaceAll(forCharacter: character.id, rows: [])
            let loaded = try await inventory.loadAll(forCharacter: character.id)
            #expect(loaded.isEmpty)
        }
    }
}
