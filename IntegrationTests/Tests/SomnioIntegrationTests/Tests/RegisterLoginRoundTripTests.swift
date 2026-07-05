import Logging
import SomnioCore
import SomnioData
import Testing

@Suite(.requiresContainerRuntime)
struct RegisterLoginRoundTripTests {
    @Test func `register then logout snapshot then load reproduces character state`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.register-login")
            let accounts = PostgresAccountRepository(client: client, logger: logger)
            let characters = PostgresCharacterRepository(client: client, logger: logger)
            let inventory = PostgresInventoryRepository(client: client, logger: logger)

            let account = try await accounts.create(
                name: "alice",
                passwordHash: "argon2-stub",
                email: "alice@example.com"
            )
            let character = try await characters.create(
                accountId: account.id,
                name: "Alice the Bold",
                figure: 2,
                gender: .female
            )
            try await inventory.replaceAll(
                forCharacter: character.id,
                rows: [
                    InventoryRow(slot: 0, category: 0, itemId: 0, extras: [InventoryExtra(key: "gold", value: 100)]),
                    InventoryRow(slot: 1, category: 1, itemId: 0)
                ]
            )

            var moved = character
            moved.position = GridPoint(x: 4, y: 7)
            // Fractional degrees pin the REAL column round-trip, not just cardinal values.
            moved.facing = Heading(degrees: 137.5)
            moved.energy.hpCurrent = 75
            // Bump `lastSeen` so the SQL skip-if-stale guard in `snapshot` accepts the write.
            // Production paths bump this in `PerSectorActor.snapshotForPlayer`/`snapshotForCheckpoint`.
            moved.lastSeen = character.lastSeen.addingTimeInterval(60)
            let updated = try await characters.snapshot(moved)
            #expect(updated == true)

            let reloadedCharacter = try #require(try await characters.findByName("Alice the Bold"))
            #expect(reloadedCharacter.position == GridPoint(x: 4, y: 7))
            #expect(reloadedCharacter.facing == Heading(degrees: 137.5))
            #expect(reloadedCharacter.energy.hpCurrent == 75)

            let reloadedInventory = try await inventory.loadAll(forCharacter: character.id)
            #expect(reloadedInventory.count == 2)
            #expect(reloadedInventory[0].extras.first?.key == "gold")
            #expect(reloadedInventory[0].extras.first?.value == 100)
        }
    }
}
