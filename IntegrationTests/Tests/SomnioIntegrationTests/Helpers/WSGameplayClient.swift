import Foundation
import Hummingbird
import HummingbirdWebSocket
import HummingbirdWSClient
import Logging
import NIOCore
import NIOFoundationCompat
import NIOWebSocket
import PostgresNIO
import ServiceLifecycle
import SomnioCore
import SomnioData
import SomnioProtocol
import SomnioServerCore
import SomnioTestSupport

/// Shared WebSocket + service-group helpers consumed by every gameplay-side integration suite.
/// Extracted from `GameplayE2ETests.swift` so the additional faithfulness suites can reuse one
/// canonical implementation of the rig builder, the wire-send shims, the drain state-machine
/// helpers, and the world-clock seed step.
enum WSGameplayClient {
    struct Rig {
        let application: Application<RouterResponder<BasicWebSocketRequestContext>>
        let dependencies: ConnectionDependencies
        let onServerRunning: PortPromise
    }

    // MARK: - Setup helpers

    static func makeApplication(
        client: PostgresClient,
        logger: Logger,
        sectors: [String: Sector]? = nil,
        worldClockInterval: Duration = .milliseconds(250)
    ) async throws -> Rig {
        let resolvedSectors = try sectors ?? IntegrationTestFixtures.defaultSectors()
        let dependencies = try await IntegrationTestFixtures.makeConnectionDependencies(
            client: client,
            sectors: resolvedSectors,
            logger: logger,
            worldClockInterval: worldClockInterval
        )
        let adminDependencies = try await GameplayRouteTestApplication.makeAdminDependencies(
            worldRouter: dependencies.worldRouter,
            worldClock: dependencies.worldClock
        )
        let portPromise = PortPromise()
        let application = GameplayRouteTestApplication.make(
            postgres: client,
            dependencies: dependencies,
            adminDependencies: adminDependencies,
            adminToken: "test"
        ) { channel in
            if let port = channel.localAddress?.port {
                await portPromise.set(port)
            }
        }
        return Rig(
            application: application,
            dependencies: dependencies,
            onServerRunning: portPromise
        )
    }

    static func seedClock(
        client: PostgresClient,
        clock: WorldClock = WorldClock(second: 50, minute: 11, hour: 7, day: 1, month: 1, year: 500),
        logger: Logger? = nil
    ) async throws {
        let seedLogger = logger ?? Logger(label: "test.somnio-integration.clock-seed")
        let seedRepo = PostgresWorldClockRepository(client: client, logger: seedLogger)
        try await seedRepo.save(clock)
    }

    static func wsConfig() -> WebSocketClientConfiguration {
        var configuration = WebSocketClientConfiguration()
        configuration.maxFrameSize = SomnioProtocolConstants.maxWireFrameSize
        return configuration
    }

    // MARK: - Wire helpers

    static func makeRegister(nickname: String, email: String) -> RegisterMessage {
        RegisterMessage(
            nickname: nickname,
            password: "passw0rd",
            passwordRepeat: "passw0rd",
            characterClass: CharacterClass.fighter.rawValue,
            gender: Gender.female.rawValue,
            email: email
        )
    }

    static func sendMessage(_ message: SomnioMessage, on outbound: WebSocketOutboundWriter) async throws {
        let frame = try SomnioMessageEncoder.encode(message)
        try await outbound.write(.text(String(decoding: frame, as: UTF8.self)))
    }

    static func sendPosition(_ origin: GridPoint, on outbound: WebSocketOutboundWriter) async throws {
        try await sendMessage(
            .clientPosition(
                PositionMessage(
                    entityIndex: 0,
                    x: origin.x,
                    y: origin.y,
                    facing: Heading(cardinal: .south).degrees,
                    tempo: Tempo.default.rawValue
                )
            ),
            on: outbound
        )
    }

    static func registerAndLogin(nickname: String, on outbound: WebSocketOutboundWriter) async throws {
        try await sendMessage(
            .register(makeRegister(nickname: nickname, email: "\(nickname)@example.com")),
            on: outbound
        )
        try await sendMessage(
            .login(LoginMessage(nickname: nickname, password: "passw0rd")),
            on: outbound
        )
    }

    /// Send only `.login` for an already-registered nickname. Used by reconnect flows where
    /// the account row already exists and a second `.register` would echo back
    /// `registerResult.nicknameExists` ahead of the login frames.
    static func loginOnly(nickname: String, on outbound: WebSocketOutboundWriter) async throws {
        try await sendMessage(
            .login(LoginMessage(nickname: nickname, password: "passw0rd")),
            on: outbound
        )
    }

    // MARK: - Drain helpers

    static func drainUntilLoginOk(inbound: WebSocketInboundStream, recorder: FrameRecorder) async throws {
        try await drainUntil(inbound: inbound, recorder: recorder) {
            if case let .loginResult(payload) = $0, payload.result == .ok { return true }
            return false
        }
    }

    /// Wait for the join sequence to land — `.dateTick` is the documented last frame
    /// (`LoginRegisterHandlerTests` asserts `tags.last == .dateTick`) so once it arrives
    /// the connection is fully `attached`. Sending gameplay frames before this races
    /// against `ConnectionActor.markAttached`, dropping them through the protocol-error
    /// guard for `.awaitingLogin`.
    static func drainUntilJoinComplete(inbound: WebSocketInboundStream, recorder: FrameRecorder) async throws {
        try await drainUntil(inbound: inbound, recorder: recorder) {
            if case .dateTick = $0 { return true }
            return false
        }
    }

    static func drainUntil(
        inbound: WebSocketInboundStream,
        recorder: FrameRecorder,
        predicate: @Sendable @escaping (SomnioMessage) -> Bool
    ) async throws {
        for try await message in inbound.messages(maxSize: SomnioProtocolConstants.maxWireFrameSize) {
            if case let .text(string) = message {
                let frame = Data(string.utf8)
                await recorder.append(frame)
                if let decoded = try? SomnioMessageDecoder.decode(frame), predicate(decoded) { return }
            }
        }
    }

    static func drainUntilPeerClosed(inbound: WebSocketInboundStream, recorder: FrameRecorder) async throws {
        for try await message in inbound.messages(maxSize: SomnioProtocolConstants.maxWireFrameSize) {
            if case let .text(string) = message {
                await recorder.append(Data(string.utf8))
            }
        }
    }

    static func drainWithTimeout(
        inbound: WebSocketInboundStream,
        recorder: FrameRecorder,
        timeout: Duration,
        predicate: @Sendable @escaping (SomnioMessage) -> Bool
    ) async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { try await drainUntil(inbound: inbound, recorder: recorder, predicate: predicate) }
            group.addTask { try await Task.sleep(for: timeout) }
            _ = try await group.next()
            group.cancelAll()
        }
    }

    static func drainCountingMatches(
        inbound: WebSocketInboundStream,
        recorder: FrameRecorder,
        timeout: Duration,
        targetMatches: Int,
        predicate: @Sendable @escaping (SomnioMessage) -> Bool
    ) async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                var matches = 0
                for try await message in inbound.messages(maxSize: SomnioProtocolConstants.maxWireFrameSize) {
                    guard case let .text(string) = message else { continue }
                    let frame = Data(string.utf8)
                    await recorder.append(frame)
                    if let decoded = try? SomnioMessageDecoder.decode(frame), predicate(decoded) {
                        matches += 1
                        if matches >= targetMatches { return }
                    }
                }
            }
            group.addTask { try await Task.sleep(for: timeout) }
            _ = try await group.next()
            group.cancelAll()
        }
    }

    // MARK: - ServiceGroup rig

    static func withServiceGroup(
        rig: Rig,
        logger: Logger,
        aiTickInterval: Duration = .seconds(AITickService.defaultAITickIntervalSeconds),
        triggerShutdownEarly: Bool = false,
        _ body: @Sendable @escaping (Int) async throws -> Void
    ) async throws {
        let services = makeSidecarServices(rig: rig, logger: logger, aiTickInterval: aiTickInterval)
        if triggerShutdownEarly {
            try await runEarlyShutdownServiceGroup(rig: rig, services: services, logger: logger, body: body)
        } else {
            try await withLiveServer(rig.application, extraServices: services, logger: logger) { client in
                try await body(client.port)
            }
        }
    }

    /// The early-shutdown branch cannot delegate to `withLiveServer`: it must trigger the
    /// group's graceful shutdown while the body is still running, and the shared helper
    /// owns its `ServiceGroup` privately. It carries the same bounded lifecycle instead —
    /// the shared startup race whose failure still tears the group down, a body
    /// completion bounded after the mid-body trigger, and a cancellation-aware drain.
    private static func runEarlyShutdownServiceGroup(
        rig: Rig,
        services: [any Service],
        logger: Logger,
        body: @Sendable @escaping (Int) async throws -> Void
    ) async throws {
        let group = makeLiveServerServiceGroup(services: [rig.application] + services, logger: logger)
        let serviceEnded = ServiceEndedPromise()
        let runTask = serviceEnded.captureRun(of: group)
        do {
            let port = try await raceStartup(
                portPromise: rig.onServerRunning,
                serviceEnded: serviceEnded,
                timeout: .seconds(5)
            )
            try await runBodyThroughEarlyShutdown(group: group, port: port, body: body)
        } catch {
            await group.triggerGracefulShutdown()
            _ = try? await drainServiceEnded(serviceEnded, runTask: runTask)
            throw error
        }
        let outcome = try await drainServiceEnded(serviceEnded, runTask: runTask)
        try outcome.get()
    }

    /// Runs `body` concurrently, triggers graceful shutdown mid-body, then bounds the
    /// body's completion: its exit depends on the server-driven WS close, so a shutdown
    /// stall would otherwise hang it before any drain. A body error stays primary. The
    /// bound is cooperative, matching `withLiveServer`: the group must still await the
    /// body child, so a body parked in a cancellation-insensitive await can outlive it.
    private static func runBodyThroughEarlyShutdown(
        group: ServiceGroup,
        port: Int,
        body: @Sendable @escaping (Int) async throws -> Void
    ) async throws {
        try await withThrowingTaskGroup(of: Void.self) { taskGroup in
            taskGroup.addTask { try await body(port) }
            try? await Task.sleep(for: .milliseconds(500))
            await group.triggerGracefulShutdown()
            taskGroup.addTask {
                try await Task.sleep(for: .seconds(10))
                throw TestTimeoutError()
            }
            _ = try await taskGroup.next()
            taskGroup.cancelAll()
        }
    }

    /// Bounded drain of the service task through the cancellation-aware promise — never a
    /// bare `await runTask.value`, which is not cancellation-responsive. On the deadline:
    /// cancel the service task and surface `LiveServerShutdownTimeout`.
    private static func drainServiceEnded(
        _ serviceEnded: ServiceEndedPromise,
        runTask: Task<Void, Never>
    ) async throws -> Result<Void, any Error> {
        do {
            return try await serviceEnded.value(timeout: .seconds(10))
        } catch is TestTimeoutError {
            runTask.cancel()
            throw LiveServerShutdownTimeout()
        }
    }

    private static func makeSidecarServices(
        rig: Rig,
        logger: Logger,
        aiTickInterval: Duration
    ) -> [any Service] {
        let checkpointService = CheckpointService(
            worldRouter: rig.dependencies.worldRouter,
            interval: .seconds(60),
            logger: logger
        )
        let aiTickService = AITickService(
            worldRouter: rig.dependencies.worldRouter,
            interval: aiTickInterval,
            logger: logger
        )
        // Register the single `WorldClockService` the rig already built — the one handlers and
        // the admin `time` verb read — so snapshot reads reflect the live, ticking clock the
        // way production does. Keep it ahead of `aiTickService` so reverse shutdown stops it
        // second, matching `RunServer`. Never run the same `Rig` in two groups concurrently:
        // the single instance's `run()` must be invoked exactly once.
        return [
            rig.dependencies.worldRouter,
            checkpointService,
            rig.dependencies.worldClock,
            aiTickService
        ]
    }
}

// MARK: - Async-safe collectors

/// Frame collector shared across the WS handler closure and the post-handler assertion.
/// Modeled as an `actor` so the WS task and the test body don't race on `frames`.
actor FrameRecorder {
    private var frames: [Data] = []

    func append(_ frame: Data) {
        frames.append(frame)
    }

    func snapshot() -> [Data] {
        frames
    }
}

typealias CloseRecorder = FirstWriteSlot<WebSocketErrorCode>
