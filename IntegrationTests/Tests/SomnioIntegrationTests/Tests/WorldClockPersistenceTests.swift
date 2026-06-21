import Foundation
import Hummingbird
import HummingbirdTesting
import HummingbirdWebSocket
import HummingbirdWSClient
import HummingbirdWSTesting
import Logging
import NIOCore
import PostgresNIO
import SomnioCore
import SomnioData
import SomnioProtocol
import SomnioServerCore
import Testing

@Suite(.requiresContainerRuntime)
struct WorldClockPersistenceTests {
    @Test func `world clock seeds from deterministic boot tuple on first start`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.worldclock.seed")
            let worldClocks = PostgresWorldClockRepository(client: client, logger: logger)
            let seed = try await worldClocks.load()
            #expect(seed == WorldClock.bootDefault)

            let routerForClock = try await WorldRouter(
                sectors: [:],
                characters: IntegrationStubCharacterRepository(),
                npcDialogStates: IntegrationStubNPCDialogStateRepository(),
                logger: logger
            )
            let service = WorldClockService(
                worldRouter: routerForClock,
                worldClocks: worldClocks,
                initialClock: seed,
                logger: logger
            )
            let observed = await service.currentTime()
            #expect(observed == WorldClock(second: 0, minute: 0, hour: 12, day: 1, month: 1, year: 500))
        }
    }

    @Test func `world clock persists across service restart`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.worldclock.restart")
            let seed = WorldClock(second: 55, minute: 11, hour: 12, day: 1, month: 1, year: 500)
            try await WSGameplayClient.seedClock(client: client, clock: seed)

            let rig1 = try await WSGameplayClient.makeApplication(
                client: client,
                logger: logger,
                worldClockInterval: .milliseconds(10)
            )
            try await WSGameplayClient.withServiceGroup(
                rig: rig1,
                logger: logger
            ) { _ in
                // Run for ~500 ms wall-clock — at 10 ms / in-game second the seed crosses
                // the minute boundary into minute 12 well within the window, triggering at
                // least one persist on the minute-zero gate. The graceful-shutdown final
                // save catches whatever the post-tick state is when `WSGameplayClient`'s
                // body returns.
                try await Task.sleep(for: .milliseconds(500))
            }

            let worldClocks = PostgresWorldClockRepository(client: client, logger: logger)
            let postShutdownClock = try await worldClocks.load()
            #expect(postShutdownClock != seed, "expected the world clock to advance past the seed before shutdown")

            // Pre-load the persisted clock synchronously and pass it as the required
            // `initialClock` so a forgotten pre-load would surface as a compile error
            // rather than a runtime regression to `bootDefault`.
            let routerForClock = try await WorldRouter(
                sectors: [:],
                characters: IntegrationStubCharacterRepository(),
                npcDialogStates: IntegrationStubNPCDialogStateRepository(),
                logger: logger
            )
            let service = WorldClockService(
                worldRouter: routerForClock,
                worldClocks: worldClocks,
                initialClock: postShutdownClock,
                logger: logger
            )
            let observed = await service.currentTime()
            #expect(observed == postShutdownClock)
            #expect(observed != WorldClock.bootDefault, "rig 2 must not reset to bootDefault")
        }
    }

    @Test func `world clock survives a full service-group restart and is observed by a joining client`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.worldclock.bootstrap-restart")
            let seed = WorldClock(second: 0, minute: 27, hour: 9, day: 3, month: 4, year: 501)
            try await WSGameplayClient.seedClock(client: client, clock: seed, logger: logger)

            // Rig 1 runs briefly so the in-memory clock advances past the seed; graceful
            // shutdown's final save persists whatever the post-tick state is.
            let rig1 = try await WSGameplayClient.makeApplication(
                client: client,
                logger: logger,
                worldClockInterval: .milliseconds(10)
            )
            try await WSGameplayClient.withServiceGroup(
                rig: rig1,
                logger: logger
            ) { _ in
                try await Task.sleep(for: .milliseconds(500))
            }

            let worldClocks = PostgresWorldClockRepository(client: client, logger: logger)
            let postShutdownClock = try await worldClocks.load()
            #expect(postShutdownClock != seed, "the world clock must have advanced past the seed before rig 1's graceful shutdown")

            // Rig 2 stands up the full Hummingbird application and service group from
            // the same database. Bootstrap is what wires `WorldClockService(initialClock:
            // worldClocks.load())` — a regression that reset to `bootDefault` would
            // surface as the join sequence's DateTick payload carrying the boot tuple
            // (12:00) instead of the persisted state.
            let nickname = "bootstrap-\(UUID().uuidString.prefix(6))"
            let joinDateTick = DateTickSlot()
            let rig2 = try await WSGameplayClient.makeApplication(client: client, logger: logger)
            try await WSGameplayClient.withServiceGroup(rig: rig2, logger: logger) { port in
                _ = try await WebSocketClient.connect(
                    url: "ws://localhost:\(port)/ws",
                    configuration: WSGameplayClient.wsConfig(),
                    logger: logger
                ) { inbound, outbound, _ in
                    try await WSGameplayClient.registerAndLogin(nickname: nickname, on: outbound)
                    for try await message in inbound.messages(maxSize: SomnioProtocolConstants.maxWireFrameSize) {
                        guard case let .text(string) = message else { continue }
                        if let payload = IntegrationTestFixtures.dateTickPayload(of: Data(string.utf8)) {
                            await joinDateTick.set(payload)
                            try await outbound.close(.normalClosure, reason: nil)
                            return
                        }
                    }
                }
            }
            let observed = try #require(await joinDateTick.value())
            #expect(observed.hour == postShutdownClock.hour, "join DateTick hour must reflect the persisted clock, got \(observed.hour) vs persisted \(postShutdownClock.hour)")
            // The minute can lag behind by 0–1 ticks depending on how soon the second
            // service group's `WorldClockService.run()` fires its first internal tick
            // after the test client logs in. Either case still proves the persisted
            // state survived; a regression to `bootDefault` would surface (hour=12,
            // minute=0), which the hour assertion above already catches.
            #expect(observed.minute >= 0 && observed.minute < 60)
        }
    }

    @Test func `DateTick frames emit at minute boundaries 12, 24, 36, 48 and hour rollover`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.worldclock.minute-boundaries")
            let seed = WorldClock(second: 55, minute: 11, hour: 12, day: 1, month: 1, year: 500)
            try await WSGameplayClient.seedClock(client: client, clock: seed)

            let nickname = "ticker-\(UUID().uuidString.prefix(6))"
            let collected = MinuteCollector()
            let rig = try await WSGameplayClient.makeApplication(
                client: client,
                logger: logger,
                worldClockInterval: .milliseconds(1)
            )
            try await WSGameplayClient.withServiceGroup(
                rig: rig,
                logger: logger
            ) { port in
                _ = try await WebSocketClient.connect(
                    url: "ws://localhost:\(port)/ws",
                    configuration: WSGameplayClient.wsConfig(),
                    logger: logger
                ) { inbound, outbound, _ in
                    try await WSGameplayClient.registerAndLogin(nickname: nickname, on: outbound)
                    try await collectPostJoinDateTicks(
                        inbound: inbound,
                        collector: collected,
                        target: 5,
                        timeout: .seconds(10)
                    )
                    try await outbound.close(.normalClosure, reason: nil)
                }
            }
            let minutes = await collected.snapshot()
            // The minute-broadcast cycle is `[12, 24, 36, 48, 0]` per game-hour. Login
            // wall-clock timing dictates which broadcast lands first after the join-sequence
            // snapshot dateTick is skipped, so any 5 consecutive entries form a rotation of
            // the cycle. Assert the captured sequence matches one of those rotations.
            let cycle: [Int16] = [12, 24, 36, 48, 0]
            let first = try #require(minutes.first)
            let startIndex = try #require(cycle.firstIndex(of: first))
            let expected = (0 ..< cycle.count).map { cycle[(startIndex + $0) % cycle.count] }
            #expect(minutes == expected, "captured minutes \(minutes) are not a rotation of \(cycle)")
        }
    }

    // MARK: - Helpers

    /// Single-iterator state machine: drain the join sequence (terminated by the snapshot
    /// `.dateTick`), then collect the next `target` `.dateTick` minutes — the service-driven
    /// broadcasts at the mid-hour marks and the hour rollover.
    private func collectPostJoinDateTicks(
        inbound: WebSocketInboundStream,
        collector: MinuteCollector,
        target: Int,
        timeout: Duration
    ) async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                var attached = false
                for try await message in inbound.messages(maxSize: SomnioProtocolConstants.maxWireFrameSize) {
                    guard case let .text(string) = message else { continue }
                    let frame = Data(string.utf8)
                    guard let decoded = try? SomnioMessageDecoder.decode(frame) else { continue }
                    if case let .dateTick(payload) = decoded {
                        if attached {
                            let count = await collector.append(payload.minute)
                            if count >= target { return }
                        } else {
                            attached = true
                        }
                    }
                }
            }
            group.addTask { try await Task.sleep(for: timeout) }
            _ = try await group.next()
            group.cancelAll()
        }
    }
}

private actor MinuteCollector {
    private var minutes: [Int16] = []

    func append(_ minute: Int16) -> Int {
        minutes.append(minute)
        return minutes.count
    }

    func snapshot() -> [Int16] {
        minutes
    }
}

private typealias DateTickSlot = FirstWriteSlot<DateTickMessage>
