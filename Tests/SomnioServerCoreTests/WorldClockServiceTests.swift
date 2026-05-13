import Foundation
import Logging
import ServiceLifecycle
import SomnioCore
import SomnioData
import SomnioProtocol
import SomnioTestSupport
import Testing
@testable import SomnioServerCore

/// Coverage for `WorldClockService.tickOnce()` — the deterministic test seam the periodic
/// service drives on a `Duration` cadence in production. Tests construct the service with a
/// pre-loaded `initialClock` and exercise the broadcast / persist gates without sleeping.
struct WorldClockServiceTests {
    @Test func `tick at minute twelve emits a date tick`() async throws {
        let recorder = SaveRecorder()
        let router = try await makeEmptyRouter()
        let service = WorldClockService(
            worldRouter: router,
            worldClocks: recorder,
            initialClock: WorldClock(second: 59, minute: 11, hour: 12, day: 1, month: 1, year: 500),
            logger: Logger(label: "test.world-clock")
        )
        let connection = try await ConnectionActor(dependencies: makeStubDependencies(router: router))
        let outbox = await connection.connectionOutbox
        let accountId = UUID()
        _ = await router.register(actor: connection, accountId: accountId, characterName: "TestPlayer")
        // The world-clock broadcast gates on `attached` state so the post-login join
        // sequence cannot get a stray `dateTick` ahead of `loginResult`/`enterSector`.
        await connection.markAttached(entityIndex: 1, sectorName: "X", accountId: accountId)

        await service.tickOnce()
        outbox.finish()

        let frames = await collect(outbox: outbox)
        let dateTicks = decodeDateTicks(in: frames)
        #expect(dateTicks.count == 1)
        #expect(dateTicks.first?.hour == 12)
        #expect(dateTicks.first?.minute == 12)
        let saved = await recorder.snapshot()
        #expect(saved.count == 1)
        await router.unregister(accountId: accountId)
    }

    @Test func `tick at minute eleven persists but does not emit`() async throws {
        let recorder = SaveRecorder()
        let router = try await makeEmptyRouter()
        let service = WorldClockService(
            worldRouter: router,
            worldClocks: recorder,
            initialClock: WorldClock(second: 59, minute: 10, hour: 12, day: 1, month: 1, year: 500),
            logger: Logger(label: "test.world-clock")
        )
        let connection = try await ConnectionActor(dependencies: makeStubDependencies(router: router))
        let outbox = await connection.connectionOutbox
        let accountId = UUID()
        _ = await router.register(actor: connection, accountId: accountId, characterName: "TestPlayer")
        // The world-clock broadcast gates on `attached` state so the post-login join
        // sequence cannot get a stray `dateTick` ahead of `loginResult`/`enterSector`.
        await connection.markAttached(entityIndex: 1, sectorName: "X", accountId: accountId)

        await service.tickOnce()
        outbox.finish()

        let frames = await collect(outbox: outbox)
        #expect(decodeDateTicks(in: frames).isEmpty)
        // Crossing into a new minute always persists, regardless of the broadcast gate.
        let saved = await recorder.snapshot()
        #expect(saved.count == 1)
        await router.unregister(accountId: accountId)
    }

    @Test func `midnight tick emits hour twenty four on the wire`() async throws {
        let recorder = SaveRecorder()
        let router = try await makeEmptyRouter()
        let service = WorldClockService(
            worldRouter: router,
            worldClocks: recorder,
            initialClock: WorldClock(second: 59, minute: 59, hour: 23, day: 1, month: 1, year: 500),
            logger: Logger(label: "test.world-clock")
        )
        let connection = try await ConnectionActor(dependencies: makeStubDependencies(router: router))
        let outbox = await connection.connectionOutbox
        let accountId = UUID()
        _ = await router.register(actor: connection, accountId: accountId, characterName: "TestPlayer")
        // The world-clock broadcast gates on `attached` state so the post-login join
        // sequence cannot get a stray `dateTick` ahead of `loginResult`/`enterSector`.
        await connection.markAttached(entityIndex: 1, sectorName: "X", accountId: accountId)

        await service.tickOnce()
        outbox.finish()

        let frames = await collect(outbox: outbox)
        let dateTicks = decodeDateTicks(in: frames)
        let firstTick = try #require(dateTicks.first)
        #expect(firstTick.hour == 24)
        #expect(firstTick.minute == 0)
        let internalState = await service.currentTime()
        #expect(internalState.hour == 0)
        #expect(internalState.day == 2)
        await router.unregister(accountId: accountId)
    }

    @Test func `staying in the same minute does not persist`() async throws {
        let recorder = SaveRecorder()
        let router = try await makeEmptyRouter()
        let service = WorldClockService(
            worldRouter: router,
            worldClocks: recorder,
            initialClock: WorldClock(second: 5, minute: 7, hour: 12, day: 1, month: 1, year: 500),
            logger: Logger(label: "test.world-clock")
        )

        await service.tickOnce()
        let saved = await recorder.snapshot()
        #expect(saved.isEmpty)
    }

    @Test func `boot default first tick neither emits nor persists`() async throws {
        let recorder = SaveRecorder()
        let router = try await makeEmptyRouter()
        let service = WorldClockService(
            worldRouter: router,
            worldClocks: recorder,
            initialClock: .bootDefault,
            logger: Logger(label: "test.world-clock")
        )
        let connection = try await ConnectionActor(dependencies: makeStubDependencies(router: router))
        let outbox = await connection.connectionOutbox
        let accountId = UUID()
        _ = await router.register(actor: connection, accountId: accountId, characterName: "TestPlayer")
        // The world-clock broadcast gates on `attached` state so the post-login join
        // sequence cannot get a stray `dateTick` ahead of `loginResult`/`enterSector`.
        await connection.markAttached(entityIndex: 1, sectorName: "X", accountId: accountId)

        await service.tickOnce()
        outbox.finish()

        #expect(await decodeDateTicks(in: collect(outbox: outbox)).isEmpty)
        #expect(await recorder.snapshot().isEmpty)
        await router.unregister(accountId: accountId)
    }

    @Test func `tickOnce logs and continues when the persistence save throws`() async throws {
        let recorder = ThrowingSaveRecorder()
        let router = try await makeEmptyRouter()
        let service = WorldClockService(
            worldRouter: router,
            worldClocks: recorder,
            initialClock: WorldClock(second: 59, minute: 10, hour: 12, day: 1, month: 1, year: 500),
            logger: Logger(label: "test.world-clock.save-fault")
        )

        // The clock crosses into a new minute on this tick, so the per-minute save gate
        // fires. The recorder throws on every save; `tickOnce` must catch the error, log,
        // and continue rather than propagate it.
        await service.tickOnce()

        let attempted = await recorder.attemptCount()
        #expect(attempted == 1)
        let stillReadable = await service.currentTime()
        #expect(stillReadable.second == 0)
        #expect(stillReadable.minute == 11)
    }

    @Test func `graceful shutdown triggers a final save even mid minute`() async throws {
        let recorder = SaveRecorder()
        let router = try await makeEmptyRouter()
        // Start at second=30 so the per-minute persist gate cannot fire during the brief
        // ticks before shutdown — the only save the recorder should observe is the final
        // one that runs after `cancelWhenGracefulShutdown` returns.
        let service = WorldClockService(
            worldRouter: router,
            worldClocks: recorder,
            initialClock: WorldClock(second: 30, minute: 5, hour: 12, day: 1, month: 1, year: 500),
            interval: .milliseconds(10),
            logger: Logger(label: "test.world-clock.shutdown")
        )
        let group = ServiceGroup(
            configuration: ServiceGroupConfiguration(
                services: [service],
                gracefulShutdownSignals: [],
                logger: Logger(label: "test.world-clock.shutdown.group")
            )
        )
        let runTask = Task { try await group.run() }
        try await Task.sleep(for: .milliseconds(50))
        await group.triggerGracefulShutdown()
        try await runTask.value

        let saved = await recorder.snapshot()
        // Final save lands regardless of whether the per-minute gate fired during the brief
        // run — that's the regression sentinel: if the post-`cancelWhenGracefulShutdown`
        // save block disappears, this expectation breaks.
        #expect(saved.isEmpty == false)
    }

    // MARK: - Helpers

    private func makeEmptyRouter() async throws -> WorldRouter {
        try await WorldRouter(
            sectors: [:],
            characters: StubCharacterRepository(),
            npcDialogStates: StubNPCDialogStateRepository(),
            logger: Logger(label: "test.world-clock-router")
        )
    }

    private func makeStubDependencies(router: WorldRouter) async throws -> ConnectionDependencies {
        let logger = Logger(label: "test.world-clock-deps")
        let worldClockService = WorldClockService(
            worldRouter: router,
            worldClocks: SaveRecorder(),
            initialClock: .bootDefault,
            logger: logger
        )
        return ConnectionDependencies(
            accounts: StubAccountRepository(),
            characters: StubCharacterRepository(),
            inventories: StubInventoryRepository(),
            registrations: StubRegistrationRepository(),
            passwordHasher: PasswordHasher(logger: logger),
            worldRouter: router,
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

    private func collect(outbox: ConnectionOutbox) async -> [Data] {
        var frames: [Data] = []
        for await frame in outbox.stream {
            frames.append(frame)
        }
        return frames
    }

    private func decodeDateTicks(in frames: [Data]) -> [DateTickMessage] {
        frames.compactMap { frame in
            guard let message = try? SomnioMessageDecoder.decode(frame) else { return nil }
            if case let .dateTick(tick) = message { return tick }
            return nil
        }
    }
}

/// Records every `save(_:)` call so tests can assert persist-gate semantics.
private actor SaveRecorder: WorldClockRepository {
    private var saved: [WorldClock] = []

    func load() async throws -> WorldClock {
        .bootDefault
    }

    func save(_ clock: WorldClock) async throws {
        saved.append(clock)
    }

    func snapshot() -> [WorldClock] {
        saved
    }
}

/// Throws on every `save(_:)` call. Used by the save-failure regression test to confirm
/// that `tickOnce`'s `do/catch` swallows the error rather than propagating it out of the
/// periodic loop.
private actor ThrowingSaveRecorder: WorldClockRepository {
    enum Fault: Error { case rigged }
    private var attempts = 0

    func load() async throws -> WorldClock {
        .bootDefault
    }

    func save(_: WorldClock) async throws {
        attempts += 1
        throw Fault.rigged
    }

    func attemptCount() -> Int {
        attempts
    }
}
