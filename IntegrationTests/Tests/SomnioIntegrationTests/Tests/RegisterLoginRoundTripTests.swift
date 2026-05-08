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
            moved.facing = .east
            moved.energy.hpCurrent = 75
            try await characters.snapshot(moved)

            let reloadedCharacter = try #require(try await characters.findByName("Alice the Bold"))
            #expect(reloadedCharacter.position == GridPoint(x: 4, y: 7))
            #expect(reloadedCharacter.facing == .east)
            #expect(reloadedCharacter.energy.hpCurrent == 75)

            let reloadedInventory = try await inventory.loadAll(forCharacter: character.id)
            #expect(reloadedInventory.count == 2)
            #expect(reloadedInventory[0].extras.first?.key == "gold")
            #expect(reloadedInventory[0].extras.first?.value == 100)
        }
    }
}
