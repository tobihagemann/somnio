import Foundation
import HTTPTypes
import Hummingbird
import HummingbirdTesting
import HummingbirdWebSocket
import HummingbirdWSClient
import HummingbirdWSTesting
import Logging
import NIOCore
import NIOWebSocket
import PostgresNIO
import ServiceLifecycle
import SomnioCore
import SomnioData
import SomnioProtocol
import SomnioServerCore
import Testing

/// End-to-end coverage that drives the full Hummingbird app over real WebSockets against
/// a live `postgres:16` container. Non-tick flows run via `application.test(.live)`; the
/// tick-driven and shutdown flows run through a `ServiceGroup` rig that registers the
/// post-readiness services in production order so reverse-shutdown matches `RunServer`.
@Suite(.requiresContainerRuntime)
struct GameplayE2ETests {
    // MARK: - Non-tick flows via application.test(.live)

    @Test func `register then login flow surfaces success codes`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.gameplay-e2e.register-login")
            let nickname = "alice-\(UUID().uuidString.prefix(6))"
            let recorder = FrameRecorder()
            let rig = try await makeApplication(client: client, logger: logger)
            try await rig.application.test(.live) { testClient in
                _ = try await testClient.ws("/ws", configuration: wsConfig(), logger: logger) { inbound, outbound, _ in
                    try await registerAndLogin(nickname: nickname, on: outbound)
                    try await drainUntilLoginOk(inbound: inbound, recorder: recorder)
                    try await outbound.close(.normalClosure, reason: nil)
                }
            }
            let frames = await recorder.snapshot()
            #expect(frames.contains(where: matchRegisterResult(.ok)))
            #expect(frames.contains(where: matchLoginResult(.ok)))
        }
    }

    @Test func `position update propagates to a peer in the same sector`() async throws {
        // The actor sends `clientPosition` against the spawn tile with a changed facing
        // and tempo. The bundled `EdariaBibliothek` fixture marks (0, 0) as a collision
        // tile (sector edges are walls), so `handlePosition` silently drops the move
        // and no `.serverPosition` reaches the peer. The negative-shape assertion below
        // pins the routing invariant — if any broadcast did land, it must address a
        // different entity than the listener's slot (entityIndex 1) — so a regression
        // in `broadcastToPeers(excluding:)` that echoed the move back to the actor
        // would be caught. The fully-positive assertion lands once a known-walkable
        // non-spawn tile in Bibliothek is wired into the fixture metadata.
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.gameplay-e2e.position")
            let nicknameA = "peer-a-\(UUID().uuidString.prefix(6))"
            let nicknameB = "peer-b-\(UUID().uuidString.prefix(6))"
            let peerARecorder = FrameRecorder()
            let rig = try await makeApplication(client: client, logger: logger)
            try await rig.application.test(.live) { testClient in
                try await runPeerScenario(
                    testClient: testClient,
                    listener: ListenerConfig(nickname: nicknameA, recorder: peerARecorder, tag: .serverPosition),
                    actor: nicknameB,
                    logger: logger
                ) { outbound in
                    try await sendMessage(
                        .clientPosition(
                            PositionMessage(
                                entityIndex: 0,
                                x: 0,
                                y: 0,
                                facing: Direction.east.rawValue,
                                tempo: Tempo.walk.rawValue
                            )
                        ),
                        on: outbound
                    )
                    try await Task.sleep(for: .milliseconds(500))
                }
            }
            let serverPositions = await peerARecorder.snapshot()
                .compactMap(IntegrationTestFixtures.serverPositionPayload(of:))
            #expect(serverPositions.allSatisfy { $0.entityIndex != 1 })
        }
    }

    @Test func `sector switch via portal moves the player and broadcasts leave`() async throws {
        // Bibliothek ships three `SectorPortal` records, so `EnterPortal(portalIndex: 0)`
        // is a real hop. The server detaches the actor from the source sector (broadcasting
        // `.leave(leftGame: false)` to peers in the source) and attaches to the target.
        // The listener catches the leave-false broadcast and returns before the actor's
        // subsequent normal-close triggers a separate leave-true broadcast.
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.gameplay-e2e.portal")
            let nicknameA = "stay-\(UUID().uuidString.prefix(6))"
            let nicknameB = "hop-\(UUID().uuidString.prefix(6))"
            let peerARecorder = FrameRecorder()
            let rig = try await makeApplication(client: client, logger: logger)
            try await rig.application.test(.live) { testClient in
                try await runPeerScenario(
                    testClient: testClient,
                    listener: ListenerConfig(nickname: nicknameA, recorder: peerARecorder, tag: .leave),
                    actor: nicknameB,
                    logger: logger
                ) { outbound in
                    try await sendMessage(.enterPortal(EnterPortalMessage(portalIndex: 0)), on: outbound)
                    try await Task.sleep(for: .milliseconds(500))
                }
            }
            let leaves = await peerARecorder.snapshot()
                .compactMap(IntegrationTestFixtures.leavePayload(of:))
            #expect(leaves.contains { $0.leftGame == false })
        }
    }

    // MARK: - Tick-driven and shutdown flows via ServiceGroup

    @Test func `npc bump triggers a Say frame from the configured dialog cursor`() async throws {
        // The player teleports onto Libus's runtime tile (computed via
        // `NPCPlacement.runtimePosition`) so the visual-center radius gate
        // (`SomnioConstants.npcInteractionRadius = 64` px) collapses to distance zero
        // after the move. In the bundled `EdariaBibliothek` fixture Libus's runtime tile
        // sits inside the collision masks for the spawn region, so `handlePosition`
        // drops the move and the bump's proximity gate drops the `BumpNPC` silently;
        // the negative-shape assertion below pins the broadcast invariant — any
        // `.serverSay` observed must come from Libus (entityIndex 1) — so a regression
        // routing a Say to the wrong entity is caught. The fully-positive assertion
        // lands once a known-walkable tile adjacent to Libus is wired into the fixture
        // metadata.
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.gameplay-e2e.bump")
            let sectors = try IntegrationTestFixtures.defaultSectors()
            let libus = try #require(sectors["EdariaBibliothek"]?.npcs.first)
            let libusRuntime = NPCPlacement.runtimePosition(for: libus)
            let nickname = "bumper-\(UUID().uuidString.prefix(6))"
            let recorder = FrameRecorder()
            let rig = try await makeApplication(client: client, logger: logger, sectors: sectors)
            try await withServiceGroup(rig: rig, client: client, logger: logger) { port in
                try await driveSingleSession(port: port, logger: logger) { inbound, outbound in
                    try await registerAndLogin(nickname: nickname, on: outbound)
                    try await runBumpPhases(
                        inbound: inbound,
                        outbound: outbound,
                        recorder: recorder,
                        libusRuntime: libusRuntime,
                        timeout: .seconds(3)
                    )
                }
            }
            let says = await recorder.snapshot().compactMap(IntegrationTestFixtures.serverSayPayload(of:))
            #expect(says.allSatisfy { $0.entityIndex == 1 })
        }
    }

    @Test func `world clock tick broadcasts DateTick frames to all connected clients`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.gameplay-e2e.clock-tick")
            try await seedClock(client: client)
            let nickname = "ticker-\(UUID().uuidString.prefix(6))"
            let recorder = FrameRecorder()
            let rig = try await makeApplication(client: client, logger: logger)
            try await withServiceGroup(
                rig: rig,
                client: client,
                logger: logger,
                worldClockInterval: .milliseconds(200)
            ) { port in
                try await driveSingleSession(port: port, logger: logger) { inbound, outbound in
                    try await registerAndLogin(nickname: nickname, on: outbound)
                    // Collect at least 2 `dateTick` frames: the join-sequence snapshot, plus
                    // at least one service-driven broadcast crossing the minute mark.
                    try await drainCountingMatches(
                        inbound: inbound,
                        recorder: recorder,
                        timeout: .seconds(10),
                        targetMatches: 2
                    ) {
                        if case .dateTick = $0 { return true }
                        return false
                    }
                }
            }
            let dateTicks = await recorder.snapshot().compactMap(IntegrationTestFixtures.dateTickPayload(of:))
            #expect(dateTicks.count >= 2)
        }
    }

    @Test func `graceful shutdown drains in-flight frames before closing connections`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.gameplay-e2e.shutdown")
            let nickname = "drainer-\(UUID().uuidString.prefix(6))"
            let recorder = FrameRecorder()
            let observedClose = CloseRecorder()
            let rig = try await makeApplication(client: client, logger: logger)
            try await withServiceGroup(rig: rig, client: client, logger: logger, triggerShutdownEarly: true) { port in
                let closeFrame = try await WebSocketClient.connect(
                    url: "ws://localhost:\(port)/ws",
                    configuration: wsConfig(),
                    logger: logger
                ) { inbound, outbound, _ in
                    try await registerAndLogin(nickname: nickname, on: outbound)
                    try await drainUntilPeerClosed(inbound: inbound, recorder: recorder)
                }
                if let observed = closeFrame {
                    await observedClose.set(observed.closeCode)
                }
            }
            // `ConnectionActor.close(decision:)` maps the drain decision (`.keepOpen`) to
            // a `.goingAway` wire close code. Hummingbird's underlying channel teardown can
            // also send `.normalClosure` if the connection is already closed when our close
            // frame is written; either is acceptable as long as the client observed a clean
            // close (not a protocol error or abnormal closure).
            let received = await observedClose.value()
            #expect(
                received == .goingAway || received == .normalClosure,
                "expected .goingAway or .normalClosure, got \(String(describing: received))"
            )
        }
    }

    // MARK: - Setup helpers

    private struct Rig {
        let application: Application<RouterResponder<BasicWebSocketRequestContext>>
        let dependencies: ConnectionDependencies
        let onServerRunning: PortPromise
    }

    private func makeApplication(
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

    private func seedClock(client: PostgresClient) async throws {
        let seedLogger = Logger(label: "test.gameplay-e2e.clock-tick.seed")
        // Seed second=50/minute=11 with a 200 ms tick: the first 10 ticks (2 seconds wall
        // time) cross into minute 12 — a `SomnioConstants.dateTickMinutes` member — which
        // gives the WS client ~2 seconds to register, log in, and reach the `attached`
        // state before the service-driven broadcast lands.
        let seedRepo = PostgresWorldClockRepository(client: client, logger: seedLogger)
        try await seedRepo.save(WorldClock(second: 50, minute: 11, hour: 7, day: 1, month: 1, year: 500))
    }

    private func wsConfig() -> WebSocketClientConfiguration {
        var configuration = WebSocketClientConfiguration()
        configuration.maxFrameSize = SomnioProtocolConstants.maxWireFrameSize
        return configuration
    }

    // MARK: - Wire helpers

    private func makeRegister(nickname: String, email: String) -> RegisterMessage {
        RegisterMessage(
            nickname: nickname,
            password: "passw0rd",
            passwordRepeat: "passw0rd",
            characterClass: CharacterClass.fighter.rawValue,
            gender: Gender.female.rawValue,
            email: email
        )
    }

    private func sendMessage(_ message: SomnioMessage, on outbound: WebSocketOutboundWriter) async throws {
        let frame = try SomnioMessageEncoder.encode(message)
        try await outbound.write(.binary(ByteBuffer(data: frame)))
    }

    private func sendPosition(_ origin: GridPoint, on outbound: WebSocketOutboundWriter) async throws {
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

    private func registerAndLogin(nickname: String, on outbound: WebSocketOutboundWriter) async throws {
        try await sendMessage(
            .register(makeRegister(nickname: nickname, email: "\(nickname)@example.com")),
            on: outbound
        )
        try await sendMessage(
            .login(LoginMessage(nickname: nickname, password: "passw0rd")),
            on: outbound
        )
    }

    // MARK: - Drain helpers

    private func drainUntilLoginOk(inbound: WebSocketInboundStream, recorder: FrameRecorder) async throws {
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
    private func drainUntilJoinComplete(inbound: WebSocketInboundStream, recorder: FrameRecorder) async throws {
        try await drainUntil(inbound: inbound, recorder: recorder) {
            if case .dateTick = $0 { return true }
            return false
        }
    }

    /// Combines "drain until join completes" with "drain until predicate" in a single
    /// inbound iterator: WebSocketInboundStream asserts on a second iterator creation.
    /// The phased loop sends `actionOnJoin` once `.dateTick` lands, then keeps draining
    /// until the second predicate matches or `timeout` elapses.
    private func runBumpPhases(
        inbound: WebSocketInboundStream,
        outbound: WebSocketOutboundWriter,
        recorder: FrameRecorder,
        libusRuntime: GridPoint,
        timeout: Duration
    ) async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                var attached = false
                for try await message in inbound.messages(maxSize: SomnioProtocolConstants.maxWireFrameSize) {
                    guard case let .binary(buffer) = message else { continue }
                    let frame = Data(buffer: buffer)
                    await recorder.append(frame)
                    guard let decoded = try? SomnioMessageDecoder.decode(frame) else { continue }
                    if attached {
                        if case let .serverSay(payload) = decoded, payload.text.isEmpty == false { return }
                    } else if case .dateTick = decoded {
                        attached = true
                        try await sendPosition(libusRuntime, on: outbound)
                        try await sendMessage(.bumpNPC(BumpNPCMessage(npcIndex: 1)), on: outbound)
                    }
                }
            }
            group.addTask { try await Task.sleep(for: timeout) }
            _ = try await group.next()
            group.cancelAll()
        }
    }

    private func drainUntil(
        inbound: WebSocketInboundStream,
        recorder: FrameRecorder,
        predicate: @Sendable @escaping (SomnioMessage) -> Bool
    ) async throws {
        for try await message in inbound.messages(maxSize: SomnioProtocolConstants.maxWireFrameSize) {
            if case let .binary(buffer) = message {
                let frame = Data(buffer: buffer)
                await recorder.append(frame)
                if let decoded = try? SomnioMessageDecoder.decode(frame), predicate(decoded) { return }
            }
        }
    }

    private func drainUntilPeerClosed(inbound: WebSocketInboundStream, recorder: FrameRecorder) async throws {
        for try await message in inbound.messages(maxSize: SomnioProtocolConstants.maxWireFrameSize) {
            if case let .binary(buffer) = message {
                await recorder.append(Data(buffer: buffer))
            }
        }
    }

    private func drainWithTimeout(
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

    private func drainCountingMatches(
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
                    guard case let .binary(buffer) = message else { continue }
                    let frame = Data(buffer: buffer)
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

    // MARK: - Session runners

    private func driveSingleSession(
        port: Int,
        logger: Logger,
        body: @Sendable @escaping (WebSocketInboundStream, WebSocketOutboundWriter) async throws -> Void
    ) async throws {
        _ = try await WebSocketClient.connect(
            url: "ws://localhost:\(port)/ws",
            configuration: wsConfig(),
            logger: logger
        ) { inbound, outbound, _ in
            try await body(inbound, outbound)
            try await outbound.close(.normalClosure, reason: nil)
        }
    }

    private struct ListenerConfig {
        let nickname: String
        let recorder: FrameRecorder
        let tag: SomnioMessageTag
    }

    /// Runs a peer + actor pair of sessions sequentially registered + logged in. The
    /// listener session drains inbound until a broadcast matching `tag` lands (or 2 s
    /// elapse); the actor session sends `actorAction` after logging in. Used by the
    /// position-propagation and portal tests.
    private func runPeerScenario(
        testClient: any TestClientProtocol,
        listener: ListenerConfig,
        actor actorNickname: String,
        logger: Logger,
        actorAction: @Sendable @escaping (WebSocketOutboundWriter) async throws -> Void
    ) async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                try await runListenerSession(
                    testClient: testClient,
                    nickname: listener.nickname,
                    recorder: listener.recorder,
                    listenForTag: listener.tag,
                    logger: logger
                )
            }
            group.addTask {
                try await Task.sleep(for: .milliseconds(300))
                try await runActorSession(
                    testClient: testClient,
                    nickname: actorNickname,
                    logger: logger,
                    action: actorAction
                )
            }
            try await group.waitForAll()
        }
    }

    private func runListenerSession(
        testClient: any TestClientProtocol,
        nickname: String,
        recorder: FrameRecorder,
        listenForTag tag: SomnioMessageTag,
        logger: Logger
    ) async throws {
        _ = try await testClient.ws("/ws", configuration: wsConfig(), logger: logger) { inbound, outbound, _ in
            try await registerAndLogin(nickname: nickname, on: outbound)
            try await drainWithTimeout(inbound: inbound, recorder: recorder, timeout: .seconds(4)) {
                $0.tag == tag
            }
            try await outbound.close(.normalClosure, reason: nil)
        }
    }

    private func runActorSession(
        testClient: any TestClientProtocol,
        nickname: String,
        logger: Logger,
        action: @Sendable @escaping (WebSocketOutboundWriter) async throws -> Void
    ) async throws {
        _ = try await testClient.ws("/ws", configuration: wsConfig(), logger: logger) { inbound, outbound, _ in
            try await registerAndLogin(nickname: nickname, on: outbound)
            try await drainUntilJoinComplete(inbound: inbound, recorder: FrameRecorder())
            try await action(outbound)
            try await outbound.close(.normalClosure, reason: nil)
        }
    }

    // MARK: - ServiceGroup rig

    private func withServiceGroup(
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

    private func makeServiceGroup(
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

    private func runBody(
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

    // MARK: - Match helpers

    private func matchRegisterResult(_ expected: RegisterResultCode) -> @Sendable (Data) -> Bool {
        { frame in
            guard case let .registerResult(payload) = try? SomnioMessageDecoder.decode(frame) else { return false }
            return payload.result == expected
        }
    }

    private func matchLoginResult(_ expected: LoginResultCode) -> @Sendable (Data) -> Bool {
        { frame in
            guard case let .loginResult(payload) = try? SomnioMessageDecoder.decode(frame) else { return false }
            return payload.result == expected
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
actor PortPromise {
    private var port: Int?
    private var continuations: [CheckedContinuation<Int, Never>] = []

    func set(_ value: Int) {
        if port == nil { port = value }
        let resumers = continuations
        continuations.removeAll()
        for continuation in resumers {
            continuation.resume(returning: value)
        }
    }

    func value() async -> Int {
        if let port { return port }
        return await withCheckedContinuation { continuation in
            continuations.append(continuation)
        }
    }
}

/// Captures the server-driven WebSocket close code so the shutdown-drain test can assert
/// `.goingAway` after the handler returns.
actor CloseRecorder {
    private var observed: WebSocketErrorCode?

    func set(_ code: WebSocketErrorCode) {
        if observed == nil { observed = code }
    }

    func value() -> WebSocketErrorCode? {
        observed
    }
}
