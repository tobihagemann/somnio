import Foundation
import Logging
import SomnioCore
import SomnioData
import Testing
@testable import SomnioServerCore

private struct StubAccountRepository: AccountRepository {
    func create(name _: String, passwordHash _: String, email _: String) async throws -> Account {
        fatalError("StubAccountRepository — handler under test does not invoke this")
    }

    func findByName(_: String) async throws -> Account? {
        nil
    }

    func findById(_: UUID) async throws -> Account? {
        nil
    }
}

private struct StubCharacterRepository: CharacterRepository {
    func create(accountId _: UUID, name _: String, figure _: Int16, gender _: Gender) async throws -> Character {
        fatalError("StubCharacterRepository — handler under test does not invoke this")
    }

    func findByAccount(_: UUID) async throws -> [Character] {
        []
    }

    func findByName(_: String) async throws -> Character? {
        nil
    }

    func snapshot(_: Character) async throws -> Bool {
        false
    }

    func persistCheckpoint(character _: Character, inventory _: [InventoryRow]) async throws -> Bool {
        false
    }
}

private struct StubInventoryRepository: InventoryRepository {
    func loadAll(forCharacter _: UUID) async throws -> [InventoryRow] {
        []
    }

    func replaceAll(forCharacter _: UUID, rows _: [InventoryRow]) async throws {}
}

private struct StubRegistrationRepository: RegistrationRepository {
    // swiftlint:disable:next function_parameter_count
    func register(
        name _: String,
        passwordHash _: String,
        email _: String,
        gender _: Gender,
        figure _: Int16,
        starterInventory _: [InventoryRow]
    ) async throws -> (Account, Character) {
        fatalError("StubRegistrationRepository — handler under test does not invoke this")
    }
}

/// Unit-level coverage for `ConnectionActor` state-transition primitives that don't require
/// driving the full inbound dispatch loop. These are the regression sentinels for the portal-
/// hop entity-index propagation contract: `setAttached` must replace both the entity index and
/// the sector name while preserving the `accountId`, and must be a no-op when the connection
/// hasn't completed login yet.
struct ConnectionActorTests {
    @Test func `setAttached replaces entityIndex and sectorName while preserving accountId`() async {
        let connection = ConnectionActor(dependencies: makeStubDependencies())
        let accountId = UUID()

        await connection.markAttached(entityIndex: 1, sectorName: "EdariaBibliothek", accountId: accountId)
        await connection.setAttached(entityIndex: 7, sectorName: "EdariaArena")

        let state = await connection.currentState
        guard case let .attached(entityIndex, sectorName, observedAccountId) = state else {
            Issue.record("expected attached state after setAttached, got \(state)")
            return
        }
        #expect(entityIndex == 7)
        #expect(sectorName == "EdariaArena")
        #expect(observedAccountId == accountId)
    }

    @Test func `setAttached is a no-op while the connection is awaitingLogin`() async {
        let connection = ConnectionActor(dependencies: makeStubDependencies())

        await connection.setAttached(entityIndex: 99, sectorName: "Phantom")

        let state = await connection.currentState
        if case .attached = state {
            Issue.record("setAttached must not promote a connection out of awaitingLogin, but state is \(state)")
        }
    }

    // MARK: - Helpers

    private func makeStubDependencies() -> ConnectionDependencies {
        let logger = Logger(label: "test.connection-actor")
        return ConnectionDependencies(
            accounts: StubAccountRepository(),
            characters: StubCharacterRepository(),
            inventories: StubInventoryRepository(),
            registrations: StubRegistrationRepository(),
            passwordHasher: PasswordHasher(logger: logger),
            worldRouter: WorldRouter(
                sectors: [:],
                characters: StubCharacterRepository(),
                logger: logger
            ),
            configuration: ServerConfiguration(
                httpHost: "127.0.0.1",
                httpPort: 8080,
                adminToken: "test",
                sectorsDirectory: URL(fileURLWithPath: "/tmp")
            ),
            logger: logger
        )
    }
}
