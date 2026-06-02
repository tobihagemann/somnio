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
/// Extracted from `GameplayE2ETests.swift` so the additional faithfulness suites (R5, R7, R8,
/// R10/R11, R12, R14/R15, R27, R33) can reuse one canonical implementation of the rig builder,
/// the wire-send shims, the drain state-machine helpers, and the world-clock seed step.
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
        sectors: [String: Sector]? = nil
    ) async throws -> Rig {
        let resolvedSectors = try sectors ?? IntegrationTestFixtures.defaultSectors()
        let dependencies = try await IntegrationTestFixtures.makeConnectionDependencies(
            client: client,
            sectors: resolvedSectors,
            logger: logger
        )
        let adminDependencies = try await GameplayRouteTestApplication.makeAdminDependencies(
            worldRouter: dependencies.worldRouter,
            worldClock: dependencies.worldClock,
            logger: logger
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
                    facing: Direction.south.rawValue,
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
        client: PostgresClient,
        logger: Logger,
        worldClockInterval: Duration = .milliseconds(250),
        aiTickInterval: Duration = .milliseconds(50),
        triggerShutdownEarly: Bool = false,
        _ body: @Sendable @escaping (Int) async throws -> Void
    ) async throws {
        let group = try await makeServiceGroup(
            rig: rig,
            client: client,
            logger: logger,
            worldClockInterval: worldClockInterval,
            aiTickInterval: aiTickInterval
        )
        let runTask = Task { try await group.run() }
        let port = await rig.onServerRunning.value()
        do {
            try await runBody(group: group, port: port, triggerShutdownEarly: triggerShutdownEarly, body: body)
        } catch {
            await group.triggerGracefulShutdown()
            _ = try? await runTask.value
            throw error
        }
        try await runTask.value
    }

    private static func makeServiceGroup(
        rig: Rig,
        client: PostgresClient,
        logger: Logger,
        worldClockInterval: Duration,
        aiTickInterval: Duration
    ) async throws -> ServiceGroup {
        let worldClocks = PostgresWorldClockRepository(client: client, logger: logger)
        let initialClock = try await worldClocks.load()
        let checkpointService = CheckpointService(
            worldRouter: rig.dependencies.worldRouter,
            interval: .seconds(60),
            logger: logger
        )
        let worldClockService = WorldClockService(
            worldRouter: rig.dependencies.worldRouter,
            worldClocks: worldClocks,
            initialClock: initialClock,
            interval: worldClockInterval,
            logger: logger
        )
        let aiTickService = AITickService(
            worldRouter: rig.dependencies.worldRouter,
            interval: aiTickInterval,
            logger: logger
        )
        let services: [any Service] = [
            rig.application,
            rig.dependencies.worldRouter,
            checkpointService,
            worldClockService,
            aiTickService
        ]
        return ServiceGroup(
            configuration: ServiceGroupConfiguration(
                services: services.map {
                    ServiceGroupConfiguration.ServiceConfiguration(
                        service: $0,
                        successTerminationBehavior: .gracefullyShutdownGroup,
                        failureTerminationBehavior: .gracefullyShutdownGroup
                    )
                },
                gracefulShutdownSignals: [],
                logger: logger
            )
        )
    }

    private static func runBody(
        group: ServiceGroup,
        port: Int,
        triggerShutdownEarly: Bool,
        body: @Sendable @escaping (Int) async throws -> Void
    ) async throws {
        if triggerShutdownEarly {
            async let bodyTask: Void = body(port)
            try? await Task.sleep(for: .milliseconds(500))
            await group.triggerGracefulShutdown()
            try await bodyTask
        } else {
            try await body(port)
            await group.triggerGracefulShutdown()
        }
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

/// Resolves to the bound port once `set(_:)` is called from `onServerRunning`. Modeled
/// as an `actor` so the WS Channel's task and the test body don't race on `port`.
/// Cancellation-aware with per-token routing: if the awaiting task is cancelled before
/// the server binds (e.g., a sibling service in the task group failed), only that
/// task's continuation resumes — sibling waiters keep waiting.
actor PortPromise {
    private var port: Int?
    private var continuations: [UUID: CheckedContinuation<Int, Never>] = [:]

    func set(_ value: Int) {
        if port == nil { port = value }
        let resumers = continuations
        continuations.removeAll()
        for (_, continuation) in resumers {
            continuation.resume(returning: value)
        }
    }

    func value() async -> Int {
        if let port { return port }
        let token = UUID()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Int, Never>) in
                installWaiter(continuation, token: token)
            }
        } onCancel: {
            Task { await self.resumeOnCancel(token: token) }
        }
    }

    private func installWaiter(_ continuation: CheckedContinuation<Int, Never>, token: UUID) {
        if let port {
            continuation.resume(returning: port)
            return
        }
        if Task.isCancelled {
            continuation.resume(returning: 0)
            return
        }
        continuations[token] = continuation
    }

    private func resumeOnCancel(token: UUID) {
        guard let continuation = continuations.removeValue(forKey: token) else { return }
        continuation.resume(returning: 0)
    }
}

typealias CloseRecorder = FirstWriteSlot<WebSocketErrorCode>
