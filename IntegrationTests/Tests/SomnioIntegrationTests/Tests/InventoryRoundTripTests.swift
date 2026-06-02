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
struct InventoryRoundTripTests {
    @Test func `register then login surfaces starter inventory in Inventory frame`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.inventory.starter")
            let nickname = "starter-\(UUID().uuidString.prefix(6))"
            let recorder = FrameRecorder()
            let rig = try await WSGameplayClient.makeApplication(client: client, logger: logger)
            try await rig.application.test(.live) { testClient in
                _ = try await testClient.ws("/ws", configuration: WSGameplayClient.wsConfig(), logger: logger) { inbound, outbound, _ in
                    try await WSGameplayClient.registerAndLogin(nickname: nickname, on: outbound)
                    try await WSGameplayClient.drainUntilJoinComplete(inbound: inbound, recorder: recorder)
                    try await outbound.close(.normalClosure, reason: nil)
                }
            }
            let inventories = await recorder.snapshot().compactMap(IntegrationTestFixtures.inventoryPayload(of:))
            let starter = try #require(inventories.first)
            #expect(starter.rows.count == StarterInventory.rows.count)
            let purse = try #require(starter.rows.first { $0.slot == 0 })
            #expect(purse.category == 0)
            #expect(purse.extras.contains { $0.key == "gold" && $0.value == 100 })
            let cudgel = try #require(starter.rows.first { $0.slot == 1 })
            #expect(cudgel.category == 1)
            #expect(cudgel.itemId == 0)
            #expect(cudgel.equippedHand == .none)
        }
    }

    @Test func `EquipToggle on cudgel marks equipped hand and broadcasts updated Inventory`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.inventory.equip")
            let nickname = "equipper-\(UUID().uuidString.prefix(6))"
            let recorder = FrameRecorder()
            let rig = try await WSGameplayClient.makeApplication(client: client, logger: logger)
            try await rig.application.test(.live) { testClient in
                _ = try await testClient.ws("/ws", configuration: WSGameplayClient.wsConfig(), logger: logger) { inbound, outbound, _ in
                    try await WSGameplayClient.registerAndLogin(nickname: nickname, on: outbound)
                    try await runEquipFlow(
                        inbound: inbound,
                        outbound: outbound,
                        recorder: recorder,
                        slot: 1,
                        hand: .right,
                        timeout: .seconds(5)
                    )
                    try await outbound.close(.normalClosure, reason: nil)
                }
            }
            let inventories = await recorder.snapshot().compactMap(IntegrationTestFixtures.inventoryPayload(of:))
            #expect(inventories.count >= 2)
            let post = try #require(inventories.last)
            let cudgel = try #require(post.rows.first { $0.slot == 1 })
            #expect(cudgel.equippedHand == .right)
        }
    }

    @Test func `EquipToggle state is persisted by the WS-close checkpoint and surfaces on reconnect`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.inventory.persistence")
            let nickname = "persister-\(UUID().uuidString.prefix(6))"
            let characters = PostgresCharacterRepository(client: client, logger: logger)
            let inventories = PostgresInventoryRepository(client: client, logger: logger)
            let rig = try await WSGameplayClient.makeApplication(client: client, logger: logger)

            try await rig.application.test(.live) { testClient in
                try await sessionEquipCudgel(testClient: testClient, nickname: nickname, logger: logger)
                let postEquipRows = try await pollForCudgelEquippedHand(
                    characters: characters,
                    inventories: inventories,
                    nickname: nickname,
                    expected: .right
                )
                let postEquipCudgel = try #require(postEquipRows.first { $0.slot == 1 })
                #expect(postEquipCudgel.equippedHand == .right)

                try await sessionVerifyEquippedThenUnequip(
                    testClient: testClient,
                    nickname: nickname,
                    logger: logger
                )
                let postUnequipRows = try await pollForCudgelEquippedHand(
                    characters: characters,
                    inventories: inventories,
                    nickname: nickname,
                    expected: nil
                )
                let postUnequipCudgel = try #require(postUnequipRows.first { $0.slot == 1 })
                #expect(postUnequipCudgel.equippedHand == nil)

                try await sessionVerifyUnequipped(testClient: testClient, nickname: nickname, logger: logger)
            }
        }
    }

    // MARK: - Session helpers

    /// Block A: register, log in, equip the cudgel to the right hand, close normally.
    private func sessionEquipCudgel(
        testClient: any TestClientProtocol,
        nickname: String,
        logger: Logger
    ) async throws {
        let recorder = FrameRecorder()
        _ = try await testClient.ws("/ws", configuration: WSGameplayClient.wsConfig(), logger: logger) { inbound, outbound, _ in
            try await WSGameplayClient.registerAndLogin(nickname: nickname, on: outbound)
            try await runEquipFlow(
                inbound: inbound,
                outbound: outbound,
                recorder: recorder,
                slot: 1,
                hand: .right,
                timeout: .seconds(5)
            )
            try await outbound.close(.normalClosure, reason: nil)
        }
    }

    /// Block B: log in (account already registered), drain the join sequence, confirm the
    /// cudgel is still equipped right, then send `EquipToggle(slot: 1, hand: .none)` and
    /// wait for the broadcast confirming the unequip.
    private func sessionVerifyEquippedThenUnequip(
        testClient: any TestClientProtocol,
        nickname: String,
        logger: Logger
    ) async throws {
        let recorder = FrameRecorder()
        _ = try await testClient.ws("/ws", configuration: WSGameplayClient.wsConfig(), logger: logger) { inbound, outbound, _ in
            try await WSGameplayClient.loginOnly(nickname: nickname, on: outbound)
            try await runEquipFlow(
                inbound: inbound,
                outbound: outbound,
                recorder: recorder,
                slot: 1,
                hand: .none,
                timeout: .seconds(5)
            )
            try await outbound.close(.normalClosure, reason: nil)
        }
        let inventories = await recorder.snapshot().compactMap(IntegrationTestFixtures.inventoryPayload(of:))
        let initial = try #require(inventories.first)
        let cudgelOnJoin = try #require(initial.rows.first { $0.slot == 1 })
        #expect(cudgelOnJoin.equippedHand == .right, "expected cudgel equipped after reconnect, got \(cudgelOnJoin.equippedHand)")
    }

    /// Block C: log in once more and assert the cudgel surfaces with no equipped hand.
    private func sessionVerifyUnequipped(
        testClient: any TestClientProtocol,
        nickname: String,
        logger: Logger
    ) async throws {
        let recorder = FrameRecorder()
        _ = try await testClient.ws("/ws", configuration: WSGameplayClient.wsConfig(), logger: logger) { inbound, outbound, _ in
            try await WSGameplayClient.loginOnly(nickname: nickname, on: outbound)
            try await WSGameplayClient.drainUntilJoinComplete(inbound: inbound, recorder: recorder)
            try await outbound.close(.normalClosure, reason: nil)
        }
        let inventories = await recorder.snapshot().compactMap(IntegrationTestFixtures.inventoryPayload(of:))
        let post = try #require(inventories.first)
        let cudgel = try #require(post.rows.first { $0.slot == 1 })
        #expect(cudgel.equippedHand == .none)
    }

    // MARK: - State machines

    // Run a phased loop on a single WebSocket inbound iterator: drain to attached state
    // (terminated by `.dateTick`), send a single `EquipToggle`, then keep draining until a
    // post-equip `.inventory` broadcast arrives or `timeout` elapses.
    // swiftlint:disable:next function_parameter_count
    private func runEquipFlow(
        inbound: WebSocketInboundStream,
        outbound: WebSocketOutboundWriter,
        recorder: FrameRecorder,
        slot: Int16,
        hand: WireHand,
        timeout: Duration
    ) async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                var attached = false
                var equipSent = false
                for try await message in inbound.messages(maxSize: SomnioProtocolConstants.maxWireFrameSize) {
                    guard case let .text(string) = message else { continue }
                    let frame = Data(string.utf8)
                    await recorder.append(frame)
                    guard let decoded = try? SomnioMessageDecoder.decode(frame) else { continue }
                    if !attached {
                        if case .dateTick = decoded {
                            attached = true
                            try await WSGameplayClient.sendMessage(
                                .equipToggle(EquipToggleMessage(slot: slot, hand: hand)),
                                on: outbound
                            )
                            equipSent = true
                        }
                    } else if equipSent, case .inventory = decoded {
                        return
                    }
                }
            }
            group.addTask { try await Task.sleep(for: timeout) }
            _ = try await group.next()
            group.cancelAll()
        }
    }

    /// Poll the persisted inventory rows until the cudgel slot's `equippedHand` matches
    /// `expected`. Anchoring the poll on the outcome state (rather than on a `lastSeen`
    /// timestamp threshold) sidesteps the registration-vs-checkpoint race the plan
    /// flagged: the registration row's `lastSeen` already satisfies a pre-session
    /// timestamp gate, but its inventory still carries the starter (unequipped) cudgel,
    /// so a poll on equippedHand cleanly waits for `persistCheckpoint` to land.
    private func pollForCudgelEquippedHand(
        characters: PostgresCharacterRepository,
        inventories: PostgresInventoryRepository,
        nickname: String,
        expected: Hand?,
        sourceLocation: SourceLocation = #_sourceLocation
    ) async throws -> [InventoryRow] {
        var match: [InventoryRow]?
        for _ in 0 ..< 50 {
            try await Task.sleep(for: .milliseconds(100))
            guard let character = try await characters.findByName(nickname) else { continue }
            let rows = try await inventories.loadAll(forCharacter: character.id)
            if rows.first(where: { $0.slot == 1 })?.equippedHand == expected {
                match = rows
                break
            }
        }
        return try #require(match, sourceLocation: sourceLocation)
    }
}
