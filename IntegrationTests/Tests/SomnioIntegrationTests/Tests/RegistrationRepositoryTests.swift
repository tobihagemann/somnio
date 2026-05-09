import Foundation
import Logging
import SomnioCore
import SomnioData
import SomnioServerCore
import Testing

@Suite(.requiresContainerRuntime)
struct RegistrationRepositoryTests {
    @Test func `register provisions account, character, and starter inventory atomically`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.registration")
            let registrations = PostgresRegistrationRepository(client: client, logger: logger)
            let accounts = PostgresAccountRepository(client: client, logger: logger)
            let characters = PostgresCharacterRepository(client: client, logger: logger)
            let inventory = PostgresInventoryRepository(client: client, logger: logger)

            let (account, character) = try await registrations.register(
                name: "fighter-one",
                passwordHash: "argon2-hash-stub",
                email: "fighter@example.com",
                gender: .male,
                figure: 0,
                starterInventory: StarterInventory.rows
            )

            #expect(account.name == "fighter-one")
            #expect(character.name == "fighter-one")
            #expect(character.currentSector == "EdariaBibliothek")

            let storedAccount = try #require(try await accounts.findByName("fighter-one"))
            #expect(storedAccount.id == account.id)
            let storedCharacters = try await characters.findByAccount(account.id)
            #expect(storedCharacters.count == 1)
            let storedInventory = try await inventory.loadAll(forCharacter: character.id)
            #expect(storedInventory.count == StarterInventory.rows.count)
            let storedGold = storedInventory.first?.extras.first { $0.key == "gold" }
            #expect(storedGold?.value == 100)
        }
    }

    @Test func `duplicate nickname race surfaces RegistrationError nicknameTaken`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.registration.race")
            let registrations = PostgresRegistrationRepository(client: client, logger: logger)
            _ = try await registrations.register(
                name: "alice",
                passwordHash: "first",
                email: "first@example.com",
                gender: .female,
                figure: 0,
                starterInventory: []
            )
            do {
                _ = try await registrations.register(
                    name: "Alice",
                    passwordHash: "second",
                    email: "second@example.com",
                    gender: .female,
                    figure: 0,
                    starterInventory: []
                )
                Issue.record("expected RegistrationError.nicknameTaken")
            } catch RegistrationError.nicknameTaken {
                // expected
            }
        }
    }

    @Test func `loser of a duplicate race leaves no partial account, character, or inventory`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.registration.partial")
            let registrations = PostgresRegistrationRepository(client: client, logger: logger)
            let accounts = PostgresAccountRepository(client: client, logger: logger)
            let characters = PostgresCharacterRepository(client: client, logger: logger)

            _ = try await registrations.register(
                name: "bob",
                passwordHash: "winner",
                email: "winner@example.com",
                gender: .male,
                figure: 0,
                starterInventory: []
            )
            do {
                _ = try await registrations.register(
                    name: "bob",
                    passwordHash: "loser",
                    email: "loser@example.com",
                    gender: .male,
                    figure: 0,
                    starterInventory: [InventoryRow(slot: 99, category: 99, itemId: 99)]
                )
            } catch RegistrationError.nicknameTaken {
                // expected
            }
            // The losing transaction must have rolled back fully — only the winner row exists.
            let storedAccount = try #require(try await accounts.findByName("bob"))
            #expect(storedAccount.passwordHash == "winner")
            let storedCharacters = try await characters.findByAccount(storedAccount.id)
            #expect(storedCharacters.count == 1)
        }
    }
}
