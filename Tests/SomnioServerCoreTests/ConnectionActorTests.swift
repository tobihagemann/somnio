import Foundation
import Logging
import SomnioCore
import SomnioData
import SomnioTestSupport
import Testing
@testable import SomnioServerCore

/// Unit-level coverage for `ConnectionActor` state-transition primitives that don't require
/// driving the full inbound dispatch loop. These are the regression sentinels for the portal-
/// hop entity-index propagation contract: `setAttached` must replace both the entity index and
/// the sector name while preserving the `accountId`, and must be a no-op when the connection
/// hasn't completed login yet.
struct ConnectionActorTests {
    @Test func `setAttached replaces entityIndex and sectorName while preserving accountId`() async throws {
        let connection = try await ConnectionActor(dependencies: makeStubDependencies())
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

    @Test func `setAttached is a no-op while the connection is awaitingLogin`() async throws {
        let connection = try await ConnectionActor(dependencies: makeStubDependencies())

        await connection.setAttached(entityIndex: 99, sectorName: "Phantom")

        let state = await connection.currentState
        if case .attached = state {
            Issue.record("setAttached must not promote a connection out of awaitingLogin, but state is \(state)")
        }
    }

    @Test func `disconnectForAdminKick is a no-op when there is no active read loop`() async throws {
        // Outside of `runConnection`, the actor holds no `readLoopTask`. The kick path must
        // be safe to call regardless — the cancellation is a fire-and-forget signal owned by
        // the read loop's exit path.
        let connection = try await ConnectionActor(dependencies: makeStubDependencies())
        await connection.disconnectForAdminKick()
        let state = await connection.currentState
        if case .attached = state {
            Issue.record("disconnectForAdminKick must not mutate state, but observed \(state)")
        }
    }

    // MARK: - Helpers

    private func makeStubDependencies() async throws -> ConnectionDependencies {
        let logger = Logger(label: "test.connection-actor")
        let worldRouter = try await WorldRouter(
            sectors: [:],
            characters: StubCharacterRepository(),
            npcDialogStates: StubNPCDialogStateRepository(),
            logger: logger
        )
        let worldClockService = WorldClockService(
            worldRouter: worldRouter,
            worldClocks: StubWorldClockRepository(),
            initialClock: .bootDefault,
            logger: logger
        )
        return ConnectionDependencies(
            accounts: StubAccountRepository(),
            characters: StubCharacterRepository(),
            inventories: StubInventoryRepository(),
            registrations: StubRegistrationRepository(),
            passwordHasher: PasswordHasher(logger: logger),
            worldRouter: worldRouter,
            worldClock: worldClockService,
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
