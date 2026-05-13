import Foundation
import SomnioCore
import SomnioData

/// Shared no-op repository stubs. Test targets that need only the "do nothing" contract
/// import these directly; targets that need recording or fault-injection behavior keep
/// their specialized variants alongside the test using them. Public because
/// `SomnioTestSupport` is a library target consumed by both `SomnioServerCoreTests` and
/// `SomnioCLICoreTests`.
public struct StubAccountRepository: AccountRepository {
    public init() {}

    public func create(name _: String, passwordHash _: String, email _: String) async throws -> Account {
        fatalError("StubAccountRepository: create is not used by these tests")
    }

    public func findByName(_: String) async throws -> Account? {
        nil
    }

    public func findById(_: UUID) async throws -> Account? {
        nil
    }
}

public struct StubCharacterRepository: CharacterRepository {
    public init() {}

    public func create(accountId _: UUID, name _: String, figure _: Int16, gender _: Gender) async throws -> Character {
        fatalError("StubCharacterRepository: create is not used by these tests")
    }

    public func findByAccount(_: UUID) async throws -> [Character] {
        []
    }

    public func findByName(_: String) async throws -> Character? {
        nil
    }

    public func snapshot(_: Character) async throws -> Bool {
        false
    }

    public func persistCheckpoint(character _: Character, inventory _: [InventoryRow]) async throws -> Bool {
        false
    }
}

public struct StubInventoryRepository: InventoryRepository {
    public init() {}

    public func loadAll(forCharacter _: UUID) async throws -> [InventoryRow] {
        []
    }

    public func replaceAll(forCharacter _: UUID, rows _: [InventoryRow]) async throws {}
}

public struct StubRegistrationRepository: RegistrationRepository {
    public init() {}

    // swiftlint:disable:next function_parameter_count
    public func register(
        name _: String,
        passwordHash _: String,
        email _: String,
        gender _: Gender,
        figure _: Int16,
        starterInventory _: [InventoryRow]
    ) async throws -> (Account, Character) {
        fatalError("StubRegistrationRepository: register is not used by these tests")
    }
}

public struct StubNPCDialogStateRepository: NPCDialogStateRepository {
    public init() {}

    public func find(sectorName _: String, npcIndex _: Int16) async throws -> NPCDialogState? {
        nil
    }

    public func loadAll(sectorName _: String) async throws -> [NPCDialogState] {
        []
    }

    public func upsert(_: NPCDialogState) async throws {}
    public func reset(sectorName _: String, npcIndex _: Int16) async throws {}
}

public struct StubWorldClockRepository: WorldClockRepository {
    public init() {}

    public func load() async throws -> WorldClock {
        .bootDefault
    }

    public func save(_: WorldClock) async throws {}
}
