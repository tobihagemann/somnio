import Foundation
import Logging
import SomnioCore
import SomnioData
import SomnioServerCore

/// Assembles a fully-stubbed `ConnectionDependencies` whose repositories all return the no-op
/// "nothing persisted" contract (`StubRepositories.swift`). The single source of truth for the
/// `ConnectionActor` unit suites — both the state-primitive tests and the new dispatch /
/// drain-ordering tests build their actor from this.
///
/// `sectors` and `characters` default to the empty world every existing caller wants, and are
/// overridable together because `LoginHandler.completeAuthenticatedJoin` needs *both* to get past
/// its guards: an account with no character answers `badCredentials`, and so does a character whose
/// sector is not in the router. Either default alone leaves the login success path — and with it
/// the request-gated token issuance — unreachable.
public func makeStubConnectionDependencies(
    logger: Logger = Logger(label: "test.connection-actor"),
    outboxHighWatermark: Int = 1024,
    sessions: any SessionRepository = StubSessionRepository(),
    sectors: [String: Sector] = [:],
    characters: StubCharacterRepository = StubCharacterRepository(),
    accounts: StubAccountRepository = StubAccountRepository()
) async throws -> ConnectionDependencies {
    let worldRouter = try await WorldRouter(
        sectors: sectors,
        characters: characters,
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
        accounts: accounts,
        characters: characters,
        inventories: StubInventoryRepository(),
        registrations: StubRegistrationRepository(),
        sessions: sessions,
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

/// Drains a connection's outbox to completion.
///
/// Shared rather than copied per suite: the drain is the same three lines everywhere, and a suite
/// that writes its own tends to weld decoding into it, at which point nothing composes and the next
/// suite writes a fourth variant. Decoding stays separate — callers map the frames themselves.
///
/// The stream must already be finished (the connection closed or its outbox terminated); this
/// awaits termination rather than polling, so a live outbox never returns.
public func collect(outbox: ConnectionOutbox) async -> [Data] {
    var frames: [Data] = []
    for await frame in outbox.stream {
        frames.append(frame)
    }
    return frames
}
