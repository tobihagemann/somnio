import Foundation
import Logging
import ServiceLifecycle
import SomnioCore
import SomnioData
import Testing
@testable import SomnioServerCore

/// Coverage for `AITickService.run()` cancellation semantics. The service has no per-tick
/// test seam; the contract is "wakes up every `interval`, calls `runAITickAcrossSectors`,
/// returns cleanly when its sleep is cancelled."
struct AITickServiceTests {
    @Test func `cancellation lets run return cleanly without throwing`() async throws {
        let logger = Logger(label: "test.ai-tick-service")
        let router = try await WorldRouter(
            sectors: [:],
            characters: AITickServiceStubCharacterRepository(),
            npcDialogStates: AITickServiceStubDialogRepository(),
            logger: logger
        )
        let service = AITickService(
            worldRouter: router,
            interval: .milliseconds(10),
            logger: logger
        )
        let task = Task { try await service.run() }
        try await Task.sleep(for: .milliseconds(50))
        task.cancel()
        // `Task.cancel()` propagates into the inner `Task.sleep(for:)`, which throws
        // `CancellationError`; the service's `catch is CancellationError { return }`
        // branch then unwinds `run()` cleanly. A regression that re-throws would surface
        // here as `task.value` throwing.
        try await task.value
    }
}

private struct AITickServiceStubCharacterRepository: CharacterRepository {
    func create(accountId _: UUID, name _: String, figure _: Int16, gender _: Gender) async throws -> Character {
        fatalError("not used in ai-tick-service tests")
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

private struct AITickServiceStubDialogRepository: NPCDialogStateRepository {
    func find(sectorName _: String, npcIndex _: Int16) async throws -> NPCDialogState? {
        nil
    }

    func loadAll(sectorName _: String) async throws -> [NPCDialogState] {
        []
    }

    func upsert(_: NPCDialogState) async throws {}
    func reset(sectorName _: String, npcIndex _: Int16) async throws {}
}
