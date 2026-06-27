import Foundation
import Hummingbird
import HummingbirdTesting
import HummingbirdWebSocket
import HummingbirdWSClient
import HummingbirdWSTesting
import Logging
import NIOCore
import NIOWebSocket
import SomnioCore
import SomnioProtocol
import SomnioServerCore
import Testing

/// End-to-end coverage that drives the full Hummingbird app over real WebSockets against
/// a live `postgres:16` container. Non-tick flows run via `application.test(.live)`; the
/// tick-driven and shutdown flows run through a `ServiceGroup` rig that registers the
/// post-readiness services in production order so reverse-shutdown matches `RunServer`.
@Suite(.requiresContainerRuntime)
struct GameplayE2ETests {
    /// Hoisted out of the `@Sendable` actor closure so the post-scenario assertion can match the
    /// broadcast against the exact coordinate the mover sent.
    private typealias MoveOutcome = (moverIndex: Int16, target: GridPoint)

    // MARK: - Non-tick flows via application.test(.live)

    @Test func `register then login flow surfaces success codes`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.gameplay-e2e.register-login")
            let nickname = "alice-\(UUID().uuidString.prefix(6))"
            let recorder = FrameRecorder()
            let rig = try await WSGameplayClient.makeApplication(client: client, logger: logger)
            try await rig.application.test(.live) { testClient in
                _ = try await testClient.ws("/ws", configuration: WSGameplayClient.wsConfig(), logger: logger) { inbound, outbound, _ in
                    try await WSGameplayClient.registerAndLogin(nickname: nickname, on: outbound)
                    try await WSGameplayClient.drainUntilLoginOk(inbound: inbound, recorder: recorder)
                    try await outbound.close(.normalClosure, reason: nil)
                }
            }
            let frames = await recorder.snapshot()
            #expect(frames.contains(where: matchRegisterResult(.ok)))
            #expect(frames.contains(where: matchLoginResult(.ok)))
        }
    }

    @Test func `position update propagates to a peer in the same sector`() async throws {
        // Both peers register fresh and spawn at the sector's arrival spawn — the (0, 0)
        // registration sentinel is rewritten by `LoginHandler.resolvedSpawn` because
        // `isWalkable((0, 0))` is false. The actor derives its move target from the fixture's
        // committed collision geometry and the listener's actual join-frame-derived feet box via
        // the server's own feet-box gate (`FeetMask.isClear`), so the chosen tile is one
        // `handlePosition` provably accepts and broadcasts. The positive-shape assertion below
        // matches that exact coordinate carried on the mover's slot, so it fails closed if a
        // regression drops the `broadcastToPeers(excluding:)` propagation (empty recorder). The
        // actor records its own inbound stream too: the broadcast must reach the listener but never
        // echo back to the mover, so a regression dropping `excluding:` is caught as a self-frame.
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.gameplay-e2e.position")
            let sector = try IntegrationTestFixtures.mapFixture(named: "EdariaBibliothek")
            let nicknameA = "peer-a-\(UUID().uuidString.prefix(6))"
            let nicknameB = "peer-b-\(UUID().uuidString.prefix(6))"
            let peerARecorder = FrameRecorder()
            let actorRecorder = FrameRecorder()
            let moveOutcome = FirstWriteSlot<MoveOutcome>()
            let rig = try await WSGameplayClient.makeApplication(client: client, logger: logger)
            try await rig.application.test(.live) { testClient in
                try await runPeerScenario(
                    testClient: testClient,
                    listener: ListenerConfig(nickname: nicknameA, recorder: peerARecorder, tag: .serverPosition),
                    actor: nicknameB,
                    logger: logger,
                    actorInboundRecorder: actorRecorder
                ) { outbound, joinFrames in
                    guard let outcome = try await Self.sendFirstAcceptedMove(in: sector, joinFrames: joinFrames, on: outbound) else { return }
                    await moveOutcome.set(outcome)
                }
            }
            let outcome = try #require(await moveOutcome.value())
            let serverPositions = await peerARecorder.snapshot()
                .compactMap(IntegrationTestFixtures.serverPositionPayload(of:))
            #expect(serverPositions.contains {
                $0.entityIndex == outcome.moverIndex && $0.x == outcome.target.x && $0.y == outcome.target.y
            })
            let actorSelfPositions = await actorRecorder.snapshot()
                .compactMap(IntegrationTestFixtures.serverPositionPayload(of:))
                .filter { $0.entityIndex == outcome.moverIndex }
            #expect(actorSelfPositions.isEmpty)
        }
    }

    @Test func `sector switch via portal moves the player and broadcasts leave`() async throws {
        // Only an `.outboundTrigger` portal is a walk-into exit; the server rejects
        // `.arrivalPlacement` markers as triggers (anti-spoof gate), so we resolve the trigger
        // index from the fixture rather than hardcoding it — Bibliothek's portal order is not a
        // test invariant. On a real hop the server detaches the actor from the source sector
        // (broadcasting `.leave(leftGame: false)` to peers there) and attaches to the target.
        // The listener catches the leave-false broadcast and returns before the actor's
        // subsequent normal-close triggers a separate leave-true broadcast.
        let bibliothek = try IntegrationTestFixtures.mapFixture(named: "EdariaBibliothek")
        let triggerIndex = try #require(
            bibliothek.portals.firstIndex { $0.direction == .outboundTrigger },
            "EdariaBibliothek fixture has no outboundTrigger portal to hop through"
        )
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.gameplay-e2e.portal")
            let nicknameA = "stay-\(UUID().uuidString.prefix(6))"
            let nicknameB = "hop-\(UUID().uuidString.prefix(6))"
            let peerARecorder = FrameRecorder()
            let rig = try await WSGameplayClient.makeApplication(client: client, logger: logger)
            try await rig.application.test(.live) { testClient in
                try await runPeerScenario(
                    testClient: testClient,
                    listener: ListenerConfig(nickname: nicknameA, recorder: peerARecorder, tag: .leave),
                    actor: nicknameB,
                    logger: logger
                ) { outbound, _ in
                    try await WSGameplayClient.sendMessage(.enterPortal(EnterPortalMessage(portalIndex: Int16(triggerIndex))), on: outbound)
                }
            }
            let leaves = await peerARecorder.snapshot()
                .compactMap(IntegrationTestFixtures.leavePayload(of:))
            #expect(leaves.contains { $0.leftGame == false })
        }
    }

    // MARK: - Tick-driven and shutdown flows via ServiceGroup

    @Test func `npc bump triggers a Say frame from the configured dialog cursor`() async throws {
        // Teleporting exactly onto Libus's runtime tile is dropped by `handlePosition` — not by a
        // static wall, but by Libus's own NPC feet box (the gate enumerates NPCs as blockers), so
        // the bump's proximity gate then drops the `BumpNPC` and no `.serverSay` ever fires
        // (genuinely vacuous on the empty array). Instead derive a target the server accepts:
        // scan the fixture's committed collision geometry with the server's own feet-box gate
        // (`FeetMask.isClear`, with Libus's feet box as a blocker) for the clear tile nearest
        // Libus that still falls inside the dialog radius (`isWithinDialogRadius` geometry). The
        // positive-shape assertion matches a non-empty Say from Libus (entityIndex 1) and fails
        // closed if a regression drops the dialog broadcast.
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.gameplay-e2e.bump")
            let sectors = try IntegrationTestFixtures.defaultSectors()
            let sector = try #require(sectors["EdariaBibliothek"])
            let libus = try #require(sector.npcs.first)
            let libusRuntime = NPCPlacement.runtimePosition(for: libus)
            let libusFeet = FeetMask.rect(forSpriteAt: libusRuntime, spriteSize: libus.maskSize)
            let libusFeetCenter = FeetMask.center(forSpriteAt: libusRuntime, spriteSize: libus.maskSize)
            let target = try #require(
                Self.firstAcceptedPlayerOrigin(
                    in: sector,
                    nearestTo: (center: libusFeetCenter, radius: SomnioConstants.npcInteractionRadius),
                    blockers: [libusFeet]
                )
            )
            let nickname = "bumper-\(UUID().uuidString.prefix(6))"
            let recorder = FrameRecorder()
            let rig = try await WSGameplayClient.makeApplication(client: client, logger: logger, sectors: sectors)
            try await WSGameplayClient.withServiceGroup(rig: rig, logger: logger) { port in
                try await driveSingleSession(port: port, logger: logger) { inbound, outbound in
                    try await WSGameplayClient.registerAndLogin(nickname: nickname, on: outbound)
                    try await runBumpPhases(
                        inbound: inbound,
                        outbound: outbound,
                        recorder: recorder,
                        teleportTarget: target,
                        timeout: .seconds(3)
                    )
                }
            }
            let says = await recorder.snapshot().compactMap(IntegrationTestFixtures.serverSayPayload(of:))
            #expect(says.contains { $0.entityIndex == 1 && $0.text.isEmpty == false })
        }
    }

    @Test func `world clock tick broadcasts DateTick frames to all connected clients`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.gameplay-e2e.clock-tick")
            // Seed second=50/minute=11 with a 200 ms tick: the first 10 ticks (2 seconds wall
            // time) cross into minute 12 — a `SomnioConstants.dateTickMinutes` member — which
            // gives the WS client ~2 seconds to register, log in, and reach the `attached`
            // state before the service-driven broadcast lands.
            try await WSGameplayClient.seedClock(client: client)
            let nickname = "ticker-\(UUID().uuidString.prefix(6))"
            let recorder = FrameRecorder()
            let rig = try await WSGameplayClient.makeApplication(
                client: client,
                logger: logger,
                worldClockInterval: .milliseconds(200)
            )
            try await WSGameplayClient.withServiceGroup(
                rig: rig,
                logger: logger
            ) { port in
                try await driveSingleSession(port: port, logger: logger) { inbound, outbound in
                    try await WSGameplayClient.registerAndLogin(nickname: nickname, on: outbound)
                    // Collect at least 2 `dateTick` frames: the join-sequence snapshot, plus
                    // at least one service-driven broadcast crossing the minute mark.
                    try await WSGameplayClient.drainCountingMatches(
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
            let rig = try await WSGameplayClient.makeApplication(client: client, logger: logger)
            try await WSGameplayClient.withServiceGroup(rig: rig, logger: logger, triggerShutdownEarly: true) { port in
                let closeFrame = try await WebSocketClient.connect(
                    url: "ws://localhost:\(port)/ws",
                    configuration: WSGameplayClient.wsConfig(),
                    logger: logger
                ) { inbound, outbound, _ in
                    try await WSGameplayClient.registerAndLogin(nickname: nickname, on: outbound)
                    try await WSGameplayClient.drainUntilPeerClosed(inbound: inbound, recorder: recorder)
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

    // MARK: - State machines (test-specific)

    /// Combines "drain until join completes" with "drain until predicate" in a single
    /// inbound iterator: WebSocketInboundStream asserts on a second iterator creation.
    /// The phased loop sends the bump after `.dateTick` lands, then keeps draining until
    /// the first non-empty `.serverSay` arrives or `timeout` elapses.
    private func runBumpPhases(
        inbound: WebSocketInboundStream,
        outbound: WebSocketOutboundWriter,
        recorder: FrameRecorder,
        teleportTarget: GridPoint,
        timeout: Duration
    ) async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                var attached = false
                for try await message in inbound.messages(maxSize: SomnioProtocolConstants.maxWireFrameSize) {
                    guard case let .text(string) = message else { continue }
                    let frame = Data(string.utf8)
                    await recorder.append(frame)
                    guard let decoded = try? SomnioMessageDecoder.decode(frame) else { continue }
                    if attached {
                        if case let .serverSay(payload) = decoded, payload.text.isEmpty == false { return }
                    } else if case .dateTick = decoded {
                        attached = true
                        try await WSGameplayClient.sendPosition(teleportTarget, on: outbound)
                        try await WSGameplayClient.sendMessage(.bumpNPC(BumpNPCMessage(npcIndex: 1)), on: outbound)
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
            configuration: WSGameplayClient.wsConfig(),
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
    /// listener session drains inbound until a broadcast matching `tag` lands (or 4 s
    /// elapse); the actor session sends `actorAction` after logging in. When
    /// `actorInboundRecorder` is supplied it captures the actor's own inbound stream so the
    /// caller can assert on what the server did (or didn't) send the actor.
    private func runPeerScenario(
        testClient: any TestClientProtocol,
        listener: ListenerConfig,
        actor actorNickname: String,
        logger: Logger,
        actorInboundRecorder: FrameRecorder? = nil,
        actorAction: @Sendable @escaping (WebSocketOutboundWriter, [Data]) async throws -> Void
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
                    inboundRecorder: actorInboundRecorder,
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
        _ = try await testClient.ws("/ws", configuration: WSGameplayClient.wsConfig(), logger: logger) { inbound, outbound, _ in
            try await WSGameplayClient.registerAndLogin(nickname: nickname, on: outbound)
            try await WSGameplayClient.drainWithTimeout(inbound: inbound, recorder: recorder, timeout: .seconds(4)) {
                $0.tag == tag
            }
            try await outbound.close(.normalClosure, reason: nil)
        }
    }

    /// Drives the actor session through one inbound iterator (the stream forbids a second): records
    /// every frame into `inboundRecorder`, fires `action` once the join completes (`.dateTick`) with
    /// the join frames captured so far, then keeps recording for a fixed window *after* the action so
    /// the caller can inspect what the server sent the actor in response (e.g. to prove a move
    /// broadcast was not echoed back to the mover). The post-action window starts only once the
    /// action fires — the join is bounded separately by the latch timeout — so a slow join can't eat
    /// into the observation window. `action` must not block on its own timer.
    private func runActorSession(
        testClient: any TestClientProtocol,
        nickname: String,
        logger: Logger,
        inboundRecorder: FrameRecorder? = nil,
        action: @Sendable @escaping (WebSocketOutboundWriter, [Data]) async throws -> Void
    ) async throws {
        let settleWindow: Duration = .milliseconds(500)
        _ = try await testClient.ws("/ws", configuration: WSGameplayClient.wsConfig(), logger: logger) { inbound, outbound, _ in
            try await WSGameplayClient.registerAndLogin(nickname: nickname, on: outbound)
            let recorder = inboundRecorder ?? FrameRecorder()
            let actionFired = OneShotLatch()
            try await withThrowingTaskGroup(of: Void.self) { group in
                group.addTask {
                    var fired = false
                    for try await message in inbound.messages(maxSize: SomnioProtocolConstants.maxWireFrameSize) {
                        guard case let .text(string) = message else { continue }
                        let frame = Data(string.utf8)
                        await recorder.append(frame)
                        guard fired == false,
                              let decoded = try? SomnioMessageDecoder.decode(frame),
                              case .dateTick = decoded
                        else { continue }
                        fired = true
                        try await action(outbound, recorder.snapshot())
                        await actionFired.fire()
                    }
                }
                group.addTask {
                    try await actionFired.wait(timeout: .seconds(4))
                    try await Task.sleep(for: settleWindow)
                }
                _ = try await group.next()
                group.cancelAll()
            }
            try await outbound.close(.normalClosure, reason: nil)
        }
    }

    // MARK: - Geometry

    /// Scans `sector` on an 8px grid (mirroring `Sector.arrivalSpawn`) for the first player origin
    /// the server's own feet-box gate (`FeetMask.isClear`) accepts against `blockers` — the same
    /// blocker set `handlePosition` enumerates (other players and NPCs, the mover excluded). When
    /// `dialogGate` is supplied, additionally requires the candidate's feet-center to fall within
    /// the gate's `radius` of its `center` — mirroring `isWithinDialogRadius` — and returns the
    /// clear tile nearest that center. Returns `nil` when nothing qualifies, so callers
    /// `try #require` it and a fixture-geometry regression fails loudly instead of vacuously.
    private static func firstAcceptedPlayerOrigin(
        in sector: Sector,
        nearestTo dialogGate: (center: (x: Int32, y: Int32), radius: Int16)? = nil,
        blockers: [PixelRect]
    ) -> GridPoint? {
        let step: Int32 = 8
        var nearest: GridPoint?
        var nearestDistance = Int64.max
        var y: Int32 = 0
        while y < sector.pixelHeight {
            var x: Int32 = 0
            while x < sector.pixelWidth {
                let candidate = GridPoint(x: Int16(clamping: x), y: Int16(clamping: y))
                if FeetMask.isClear(
                    at: candidate,
                    spriteSize: SomnioConstants.playerSpriteSize,
                    sector: sector,
                    blockers: blockers
                ) {
                    guard let dialogGate else { return candidate }
                    let candidateCenter = FeetMask.center(forSpriteAt: candidate, spriteSize: SomnioConstants.playerSpriteSize)
                    if VisualCenter.isWithin(dialogGate.center, candidateCenter, radius: dialogGate.radius) {
                        let distance = VisualCenter.squaredDistance(dialogGate.center, candidateCenter)
                        if distance < nearestDistance {
                            nearestDistance = distance
                            nearest = candidate
                        }
                    }
                }
                x += step
            }
            y += step
        }
        return nearest
    }

    /// Parses the actor's join frames for its own slot index and the other-entity feet boxes the
    /// server enumerates as move blockers — players and NPCs, matching `handlePosition`'s
    /// `includingMonsters: false` gate — derives the first origin that gate accepts, and sends the
    /// move. Returns the slot index and chosen target so the caller can match the broadcast, or
    /// `nil` when the join frames carry no `.mainCharacter` or no clear origin exists.
    private static func sendFirstAcceptedMove(
        in sector: Sector,
        joinFrames: [Data],
        on outbound: WebSocketOutboundWriter
    ) async throws -> MoveOutcome? {
        guard let moverIndex = joinFrames
            .compactMap(IntegrationTestFixtures.mainCharacterPayload(of:))
            .first?
            .entityIndex
        else { return nil }
        let blockers = joinFrames
            .compactMap(IntegrationTestFixtures.entityPayload(of:))
            .filter { $0.entityIndex != moverIndex && $0.type != .monster }
            .map { peer in
                FeetMask.rect(
                    forSpriteAt: GridPoint(x: peer.x, y: peer.y),
                    spriteSize: GridSize(width: peer.maskWidth, height: peer.maskHeight)
                )
            }
        guard let target = firstAcceptedPlayerOrigin(in: sector, blockers: blockers) else { return nil }
        try await WSGameplayClient.sendPosition(target, on: outbound)
        return (moverIndex, target)
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
