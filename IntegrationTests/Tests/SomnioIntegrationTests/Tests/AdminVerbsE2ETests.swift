import Foundation
import HTTPTypes
import Hummingbird
import HummingbirdTesting
import HummingbirdWebSocket
import HummingbirdWSClient
import HummingbirdWSTesting
import Logging
import NIOCore
import NIOFoundationCompat
import NIOWebSocket
import SomnioCLICore
import SomnioCore
import SomnioData
import SomnioProtocol
import SomnioServerCore
import Testing

@Suite(.requiresContainerRuntime)
struct AdminVerbsE2ETests {
    @Test func `players verb returns logged-in count from live router`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.admin.players")
            let rig = try await WSGameplayClient.makeApplication(client: client, logger: logger)
            try await rig.application.test(.live) { testClient in
                let url = try await Self.adminURL(for: testClient)
                let aliceNickname = "alice-\(UUID().uuidString.prefix(6))"
                let bobNickname = "bob-\(UUID().uuidString.prefix(6))"
                let aliceRecorder = FrameRecorder()
                let bobRecorder = FrameRecorder()
                let attached = AttachCountdown(expected: 2)
                let release = ReleaseLatch()

                try await withThrowingTaskGroup(of: Void.self) { group in
                    group.addTask {
                        _ = try await runHeldGameplaySession(
                            testClient: testClient,
                            nickname: aliceNickname,
                            recorder: aliceRecorder,
                            attached: attached,
                            release: release,
                            logger: logger
                        )
                    }
                    group.addTask {
                        _ = try await runHeldGameplaySession(
                            testClient: testClient,
                            nickname: bobNickname,
                            recorder: bobRecorder,
                            attached: attached,
                            release: release,
                            logger: logger
                        )
                    }
                    await attached.awaitAll()
                    let response = try await AdminTransport.send(
                        .players,
                        to: url,
                        token: "test",
                        logger: logger
                    )
                    #expect(response == .playerCount(text: "2"))
                    await release.release()
                    try await group.waitForAll()
                }
            }
        }
    }

    @Test func `time verb returns live world clock formatted Y;M;D;HH;MM;SS`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.admin.time")
            let seed = WorldClock(second: 50, minute: 11, hour: 7, day: 1, month: 1, year: 500)
            try await WSGameplayClient.seedClock(client: client, clock: seed)
            let rig = try await WSGameplayClient.makeApplication(client: client, logger: logger)
            try await rig.application.test(.live) { testClient in
                let url = try await Self.adminURL(for: testClient)
                let response = try await AdminTransport.send(
                    .time,
                    to: url,
                    token: "test",
                    logger: logger
                )
                // `AdminCommandDispatcher` formats hour/minute/second zero-padded to 2 digits
                // and prefixes the year/month/day without padding: "Y;M;D;HH;MM;SS".
                #expect(response == .worldClock(text: "500;1;1;07;11;50"))
            }
        }
    }

    // swiftlint:disable:next function_body_length
    @Test func `say verb broadcasts AdminSay frame to every logged-in gameplay client`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.admin.say")
            let rig = try await WSGameplayClient.makeApplication(client: client, logger: logger)
            try await rig.application.test(.live) { testClient in
                let url = try await Self.adminURL(for: testClient)
                let aliceNickname = "alice-\(UUID().uuidString.prefix(6))"
                let bobNickname = "bob-\(UUID().uuidString.prefix(6))"
                let aliceRecorder = FrameRecorder()
                let bobRecorder = FrameRecorder()
                let strangerRecorder = FrameRecorder()
                let attached = AttachCountdown(expected: 2)
                let strangerHello = HelloReceivedLatch()
                let release = ReleaseLatch()

                try await withThrowingTaskGroup(of: Void.self) { group in
                    group.addTask {
                        _ = try await runHeldGameplaySession(
                            testClient: testClient,
                            nickname: aliceNickname,
                            recorder: aliceRecorder,
                            attached: attached,
                            release: release,
                            logger: logger
                        )
                    }
                    group.addTask {
                        _ = try await runHeldGameplaySession(
                            testClient: testClient,
                            nickname: bobNickname,
                            recorder: bobRecorder,
                            attached: attached,
                            release: release,
                            logger: logger
                        )
                    }
                    group.addTask {
                        _ = try await runHeldPreLoginSession(
                            testClient: testClient,
                            recorder: strangerRecorder,
                            release: release,
                            helloReceived: strangerHello,
                            logger: logger
                        )
                    }
                    // Wait for both logged-in sessions to attach AND for the pre-login
                    // stranger to receive Hello, so a "stranger receives no adminSay"
                    // assertion below isn't vacuously true on a still-connecting socket.
                    await attached.awaitAll()
                    await strangerHello.wait()

                    let response = try await AdminTransport.send(
                        .say(text: "hello world"),
                        to: url,
                        token: "test",
                        logger: logger
                    )
                    #expect(response == .sayBroadcast(text: "hello world"))

                    // Wait briefly for the broadcast to land on both logged-in outboxes.
                    try await Task.sleep(for: .milliseconds(500))

                    let aliceFrames = await aliceRecorder.snapshot()
                    let bobFrames = await bobRecorder.snapshot()
                    let strangerFrames = await strangerRecorder.snapshot()

                    let aliceAdminSays = aliceFrames.compactMap(IntegrationTestFixtures.adminSayPayload(of:))
                    let bobAdminSays = bobFrames.compactMap(IntegrationTestFixtures.adminSayPayload(of:))
                    let strangerAdminSays = strangerFrames.compactMap(IntegrationTestFixtures.adminSayPayload(of:))

                    #expect(aliceAdminSays.contains { $0.text == "hello world" })
                    #expect(bobAdminSays.contains { $0.text == "hello world" })
                    #expect(strangerAdminSays.isEmpty, "pre-login socket must not receive adminSay")

                    await release.release()
                    try await group.waitForAll()
                }
            }
        }
    }

    // swiftlint:disable:next function_body_length
    @Test func `kick verb disconnects a named player and broadcasts leave`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.admin.kick")
            let rig = try await WSGameplayClient.makeApplication(client: client, logger: logger)
            try await rig.application.test(.live) { testClient in
                let url = try await Self.adminURL(for: testClient)
                let aliceNickname = "alice-\(UUID().uuidString.prefix(6))"
                let bobNickname = "bob-\(UUID().uuidString.prefix(6))"
                let aliceRecorder = FrameRecorder()
                let bobRecorder = FrameRecorder()
                let attached = AttachCountdown(expected: 2)
                let release = ReleaseLatch()
                let aliceCloseSlot = CloseRecorder()

                try await withThrowingTaskGroup(of: Void.self) { group in
                    group.addTask {
                        let closeFrame = try await runHeldGameplaySession(
                            testClient: testClient,
                            nickname: aliceNickname,
                            recorder: aliceRecorder,
                            attached: attached,
                            release: release,
                            logger: logger
                        )
                        if let frame = closeFrame {
                            await aliceCloseSlot.set(frame.closeCode)
                        }
                    }
                    group.addTask {
                        _ = try await runHeldGameplaySession(
                            testClient: testClient,
                            nickname: bobNickname,
                            recorder: bobRecorder,
                            attached: attached,
                            release: release,
                            logger: logger
                        )
                    }
                    await attached.awaitAll()

                    let aliceFramesPreKick = await aliceRecorder.snapshot()
                    let aliceEntity = try #require(
                        aliceFramesPreKick.compactMap(IntegrationTestFixtures.mainCharacterPayload(of:)).first
                    )

                    let kickResponse = try await AdminTransport.send(
                        .kick(name: aliceNickname),
                        to: url,
                        token: "test",
                        logger: logger
                    )
                    #expect(kickResponse == .kickedPlayer(text: aliceNickname))

                    // Wait for Bob's outbox to receive Alice's `.leave` broadcast.
                    var observedLeave = false
                    for _ in 0 ..< 30 {
                        try await Task.sleep(for: .milliseconds(100))
                        let bobFrames = await bobRecorder.snapshot()
                        let leaves = bobFrames.compactMap(IntegrationTestFixtures.leavePayload(of:))
                        if leaves.contains(where: { $0.entityIndex == aliceEntity.entityIndex }) {
                            observedLeave = true
                            break
                        }
                    }
                    #expect(observedLeave, "Bob did not observe a .leave broadcast for the kicked player")

                    // Player count drops to 1 — Alice's read-loop has been cancelled and her
                    // disconnect cleanup has unregistered her from the world router.
                    let countResponse = try await AdminTransport.send(
                        .players,
                        to: url,
                        token: "test",
                        logger: logger
                    )
                    #expect(countResponse == .playerCount(text: "1"))

                    // Alice's socket must close *before* the test release fires — otherwise
                    // a regression where kick only unregistered the connection without
                    // closing the WS could pass on the test-release close frame instead.
                    var observedAliceClose: WebSocketErrorCode?
                    for _ in 0 ..< 30 {
                        try await Task.sleep(for: .milliseconds(100))
                        if let code = await aliceCloseSlot.value() {
                            observedAliceClose = code
                            break
                        }
                    }
                    #expect(observedAliceClose != nil, "Alice's socket did not close after kick (before the test release)")
                    #expect(
                        observedAliceClose == .goingAway || observedAliceClose == .normalClosure,
                        "expected server-driven close on kicked player's socket, got \(String(describing: observedAliceClose))"
                    )

                    await release.release()
                    try await group.waitForAll()
                }
            }
        }
    }

    @Test func `version verb returns configured server version`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.admin.version")
            let rig = try await WSGameplayClient.makeApplication(client: client, logger: logger)
            try await rig.application.test(.live) { testClient in
                let url = try await Self.adminURL(for: testClient)
                let response = try await AdminTransport.send(
                    .version,
                    to: url,
                    token: "test",
                    logger: logger
                )
                // `GameplayRouteTestApplication.makeAdminDependencies` pins this literal.
                #expect(response == .versionString(text: "test-version"))
            }
        }
    }

    @Test func `unknown verb responds with unknownCommand wire case and leaves session open`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.admin.unknown")
            let rig = try await WSGameplayClient.makeApplication(client: client, logger: logger)
            try await rig.application.test(.live) { testClient in
                let url = try await Self.adminURL(for: testClient)
                var configuration = WebSocketClientConfiguration()
                configuration.additionalHeaders[.authorization] = "Bearer test"
                configuration.maxFrameSize = SomnioProtocolConstants.maxWireFrameSize
                let unknownSlot = AdminResponseSlot()
                let followUpSlot = AdminResponseSlot()
                let followUpFrame = try BinaryEncoder().encode(AdminRequest.players)

                try await WebSocketClient.connect(
                    url: url,
                    configuration: configuration,
                    logger: logger
                ) { inbound, outbound, _ in
                    // The admin protocol writes the encoded request body straight onto the
                    // WS binary-frame channel — no length prefix. A single-byte body with
                    // an unrecognized tag (`0xFF`) must round-trip to `.unknownCommand`.
                    try await outbound.write(.binary(ByteBuffer(bytes: [0xFF])))
                    var receivedUnknown = false
                    for try await message in inbound.messages(maxSize: SomnioProtocolConstants.maxWireFrameSize) {
                        guard case let .binary(buffer) = message else { continue }
                        let response = try BinaryDecoder().decode(AdminResponse.self, from: Data(buffer: buffer))
                        if !receivedUnknown {
                            await unknownSlot.set(response)
                            receivedUnknown = true
                            try await outbound.write(.binary(ByteBuffer(data: followUpFrame)))
                            continue
                        }
                        await followUpSlot.set(response)
                        try? await outbound.close(.normalClosure, reason: nil)
                        return
                    }
                }

                let unknown = try #require(await unknownSlot.value())
                #expect(unknown == .unknownCommand)
                let followUp = try #require(await followUpSlot.value())
                #expect(followUp == .playerCount(text: "0"))
            }
        }
    }

    // MARK: - Helpers

    private static func adminURL(for testClient: any TestClientProtocol) async throws -> String {
        let port = try #require(testClient.port)
        return "ws://localhost:\(port)/admin"
    }
}

private typealias AdminResponseSlot = FirstWriteSlot<AdminResponse>
