import Foundation
import Logging
import SomnioData
import SomnioServerCore

/// Assembles a fully-stubbed `ConnectionDependencies` whose repositories all return the no-op
/// "nothing persisted" contract (`StubRepositories.swift`). The single source of truth for the
/// `ConnectionActor` unit suites — both the state-primitive tests and the new dispatch /
/// drain-ordering tests build their actor from this.
public func makeStubConnectionDependencies(
    logger: Logger = Logger(label: "test.connection-actor"),
    outboxHighWatermark: Int = 1024
) async throws -> ConnectionDependencies {
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
            sectorsDirectory: URL(fileURLWithPath: "/tmp"),
            outboxHighWatermark: outboxHighWatermark
        ),
        logger: logger
    )
}
