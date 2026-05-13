import Foundation
import Logging
import ServiceLifecycle
import SomnioCore
import SomnioData
import SomnioTestSupport
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
            characters: StubCharacterRepository(),
            npcDialogStates: StubNPCDialogStateRepository(),
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
