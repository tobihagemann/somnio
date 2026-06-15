import Foundation
import SomnioCore
import SomnioData

// Shared no-op repository conformances for integration suites that need a structurally
// valid `ConnectionDependencies` / `AdminConnectionDependencies` bag but don't exercise
// the gameplay or admin write paths (e.g., the degraded-DB /health probe and the
// world-clock restart fixture that only reads `WorldClockService.currentTime()`).
// `SomnioTestSupport` is intentionally not a `.library` product, so the integration
// package can't import its stubs — these mirror the same contract.

struct IntegrationStubAccountRepository: AccountRepository {
    func create(name _: String, passwordHash _: String, email _: String) async throws -> Account {
        fatalError("IntegrationStubAccountRepository: create is not used by these tests")
    }

    func findByName(_: String) async throws -> Account? {
        nil
    }

    func findById(_: UUID) async throws -> Account? {
        nil
    }
}

struct IntegrationStubCharacterRepository: CharacterRepository {
    func create(accountId _: UUID, name _: String, figure _: Int16, gender _: Gender) async throws -> Character {
        fatalError("IntegrationStubCharacterRepository: create is not used by these tests")
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

struct IntegrationStubInventoryRepository: InventoryRepository {
    func loadAll(forCharacter _: UUID) async throws -> [InventoryRow] {
        []
    }

    func replaceAll(forCharacter _: UUID, rows _: [InventoryRow]) async throws {}
}

struct IntegrationStubRegistrationRepository: RegistrationRepository {
    // swiftlint:disable:next function_parameter_count
    func register(
        name _: String,
        passwordHash _: String,
        email _: String,
        gender _: Gender,
        figure _: Int16,
        starterInventory _: [InventoryRow]
    ) async throws -> (Account, Character) {
        fatalError("IntegrationStubRegistrationRepository: register is not used by these tests")
    }
}

struct IntegrationStubNPCDialogStateRepository: NPCDialogStateRepository {
    func find(sectorName _: String, npcIndex _: Int16) async throws -> NPCDialogState? {
        nil
    }

    func loadAll(sectorName _: String) async throws -> [NPCDialogState] {
        []
    }

    func upsert(_: NPCDialogState) async throws {}
    func reset(sectorName _: String, npcIndex _: Int16) async throws {}
}

struct IntegrationStubWorldClockRepository: WorldClockRepository {
    func load() async throws -> WorldClock {
        .bootDefault
    }

    func save(_: WorldClock) async throws {}
}
