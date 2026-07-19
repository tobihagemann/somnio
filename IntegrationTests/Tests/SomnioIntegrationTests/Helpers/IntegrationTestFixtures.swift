import Foundation
import Logging
import PostgresNIO
import SomnioCore
import SomnioData
import SomnioProtocol
import SomnioServerCore
import Testing

/// Shared fixtures for the integration suites. Avoids duplicating the brittle
/// `deletingLastPathComponent` chain and the `ConnectionDependencies` literal across every
/// new test file. The map fixtures themselves live under `Tests/SomnioMapFixturesTestSupport/MapFixtures`
/// so the SwiftPM `.copy` is owned by the shared test-support target and the integration
/// package walks up to the repo root to read them as plain files.
public enum IntegrationTestFixtures {
    /// Every shipped sector fixture, keyed by name — the world every integration suite
    /// loads. Centralized so adding a fixture, renaming one, or reordering the name list
    /// happens in one place.
    public static func defaultSectors(callerFile: StaticString = #filePath) throws -> [String: Sector] {
        let names = [
            "EdariaArena", "EdariaBibliothek", "EdariaInn", "EdariaMitte",
            "EdariaShop", "Nordwald", "Nordwiese"
        ]
        return try Dictionary(uniqueKeysWithValues: names.map { name in
            try (name, mapFixture(named: name, callerFile: callerFile))
        })
    }

    public static func mapFixture(named name: String, callerFile: StaticString = #filePath) throws -> Sector {
        let testFile = URL(fileURLWithPath: "\(callerFile)")
        let repoRoot = testFile
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // SomnioIntegrationTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // IntegrationTests
            .deletingLastPathComponent() // somnio (repo root)
        let fixtureURL = repoRoot
            .appendingPathComponent("Tests/SomnioMapFixturesTestSupport/MapFixtures", isDirectory: true)
            .appendingPathComponent("\(name).somnio-sector")
        let data = try Data(contentsOf: fixtureURL)
        let body = try MapCodec.read(data)
        return Sector(body: body, name: name)
    }

    public static func makeConnectionDependencies(
        client: PostgresClient,
        sectors: [String: Sector],
        logger: Logger,
        worldClockInterval: Duration = .milliseconds(250)
    ) async throws -> ConnectionDependencies {
        let characters = PostgresCharacterRepository(client: client, logger: logger)
        let inventories = PostgresInventoryRepository(client: client, logger: logger)
        let accounts = PostgresAccountRepository(client: client, logger: logger)
        let registrations = PostgresRegistrationRepository(client: client, logger: logger)
        let npcDialogStates = PostgresNPCDialogStateRepository(client: client, logger: logger)
        let worldClocks = PostgresWorldClockRepository(client: client, logger: logger)
        let worldRouter = try await WorldRouter(
            sectors: sectors,
            characters: characters,
            npcDialogStates: npcDialogStates,
            logger: logger
        )
        let initialClock = try await worldClocks.load()
        let worldClockService = WorldClockService(
            worldRouter: worldRouter,
            worldClocks: worldClocks,
            initialClock: initialClock,
            interval: worldClockInterval,
            logger: logger
        )
        return ConnectionDependencies(
            accounts: accounts,
            characters: characters,
            inventories: inventories,
            registrations: registrations,
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

    public static func collectFrames(from outbox: ConnectionOutbox) async -> [Data] {
        var collected: [Data] = []
        for await frame in outbox.stream {
            collected.append(frame)
        }
        return collected
    }

    /// Decodes the last frame in `frames` and asserts it is `.registerResult` with
    /// `expected`. Records a focused `Issue` if the case is wrong, so a regression that
    /// flips the message tag surfaces with the actual decoded value rather than a generic
    /// expectation failure.
    public static func expectLastRegisterResult(
        _ expected: RegisterResultCode,
        in frames: [Data],
        sourceLocation: SourceLocation = #_sourceLocation
    ) throws {
        let lastFrame = try #require(frames.last, sourceLocation: sourceLocation)
        let last = try SomnioMessageDecoder.decode(lastFrame)
        guard case let .registerResult(payload) = last else {
            Issue.record("expected registerResult.\(expected), got \(last)", sourceLocation: sourceLocation)
            return
        }
        #expect(payload.result == expected, sourceLocation: sourceLocation)
    }

    /// Symmetric to `expectLastRegisterResult` for login flows.
    public static func expectLastLoginResult(
        _ expected: LoginResultCode,
        in frames: [Data],
        sourceLocation: SourceLocation = #_sourceLocation
    ) throws {
        let lastFrame = try #require(frames.last, sourceLocation: sourceLocation)
        let last = try SomnioMessageDecoder.decode(lastFrame)
        guard case let .loginResult(payload) = last else {
            Issue.record("expected loginResult.\(expected), got \(last)", sourceLocation: sourceLocation)
            return
        }
        #expect(payload.result == expected, sourceLocation: sourceLocation)
    }

    /// Decodes a single frame and returns the typed `LeaveMessage` payload, or `nil` if the
    /// frame is not a `.leave`.
    public static func leavePayload(of frame: Data) -> LeaveMessage? {
        guard let message = try? SomnioMessageDecoder.decode(frame) else { return nil }
        if case let .leave(payload) = message { return payload }
        return nil
    }

    /// Decodes a single frame and returns the typed `SayMessage` payload for the
    /// `.serverSay` case (peer chat / NPC dialog broadcasts), or `nil` otherwise.
    public static func serverSayPayload(of frame: Data) -> SayMessage? {
        guard let message = try? SomnioMessageDecoder.decode(frame) else { return nil }
        if case let .serverSay(payload) = message { return payload }
        return nil
    }

    /// Decodes a single frame and returns the typed `DateTickMessage` payload.
    public static func dateTickPayload(of frame: Data) -> DateTickMessage? {
        guard let message = try? SomnioMessageDecoder.decode(frame) else { return nil }
        if case let .dateTick(payload) = message { return payload }
        return nil
    }

    /// Decodes a single frame and returns the typed `PositionMessage` payload for the
    /// server-broadcast `.serverPosition` case (peer position updates).
    public static func serverPositionPayload(of frame: Data) -> PositionMessage? {
        guard let message = try? SomnioMessageDecoder.decode(frame) else { return nil }
        if case let .serverPosition(payload) = message { return payload }
        return nil
    }

    public static func helloPayload(of frame: Data) -> HelloMessage? {
        guard let message = try? SomnioMessageDecoder.decode(frame) else { return nil }
        if case let .hello(payload) = message { return payload }
        return nil
    }

    public static func mainCharacterPayload(of frame: Data) -> MainCharacterMessage? {
        guard let message = try? SomnioMessageDecoder.decode(frame) else { return nil }
        if case let .mainCharacter(payload) = message { return payload }
        return nil
    }

    public static func entityPayload(of frame: Data) -> EntityMessage? {
        guard let message = try? SomnioMessageDecoder.decode(frame) else { return nil }
        if case let .entity(payload) = message { return payload }
        return nil
    }

    public static func inventoryPayload(of frame: Data) -> InventoryMessage? {
        guard let message = try? SomnioMessageDecoder.decode(frame) else { return nil }
        if case let .inventory(payload) = message { return payload }
        return nil
    }

    public static func energyPayload(of frame: Data) -> Energy? {
        guard let message = try? SomnioMessageDecoder.decode(frame) else { return nil }
        if case let .energy(payload) = message { return payload }
        return nil
    }

    public static func enterSectorPayload(of frame: Data) -> EnterSectorMessage? {
        guard let message = try? SomnioMessageDecoder.decode(frame) else { return nil }
        if case let .enterSector(payload) = message { return payload }
        return nil
    }

    public static func adminSayPayload(of frame: Data) -> AdminSayMessage? {
        guard let message = try? SomnioMessageDecoder.decode(frame) else { return nil }
        if case let .adminSay(payload) = message { return payload }
        return nil
    }
}
