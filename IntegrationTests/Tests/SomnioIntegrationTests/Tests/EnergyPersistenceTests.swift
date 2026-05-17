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
struct EnergyPersistenceTests {
    @Test func `baseline energy (current, max) pairs are persisted by WS-close and surface on reconnect`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.energy.persistence")
            let nickname = "energizer-\(UUID().uuidString.prefix(6))"
            let characters = PostgresCharacterRepository(client: client, logger: logger)
            let rig = try await WSGameplayClient.makeApplication(client: client, logger: logger)

            try await rig.application.test(.live) { testClient in
                // Session 1: register + drain to attached + close. The server's
                // `snapshotForPlayer`/`persistCheckpoint` runs on close and bumps
                // `lastSeen` past the registration write. Capture the first energy
                // payload as the baseline that the reconnect must round-trip.
                let firstRecorder = FrameRecorder()
                _ = try await testClient.ws("/ws", configuration: WSGameplayClient.wsConfig(), logger: logger) { inbound, outbound, _ in
                    try await WSGameplayClient.registerAndLogin(nickname: nickname, on: outbound)
                    try await WSGameplayClient.drainUntilJoinComplete(inbound: inbound, recorder: firstRecorder)
                    try await outbound.close(.normalClosure, reason: nil)
                }
                let baselineFrames = await firstRecorder.snapshot()
                let baseline = try #require(baselineFrames.compactMap(IntegrationTestFixtures.energyPayload(of:)).first)

                // Snapshot lastSeen after session 1 has had a chance to write its close
                // checkpoint. The strict `>` advance the second session forces below is
                // what proves the WS-close persistence path actually runs — without it,
                // a regression that skipped `persistCheckpoint` on close would still
                // surface the registration row's `lastSeen` and the energy values
                // (which match baseline regardless).
                let session1LastSeen = try await CharacterCheckpointPoller.waitForCharacterRowToAppear(
                    characters: characters,
                    nickname: nickname
                )

                // Session 2: re-login + drain + close. The energy payload received on
                // join must match the baseline (the read half of the round-trip), and
                // session 2's close-checkpoint must strictly advance `lastSeen` past
                // session 1's value (proves the write half ran).
                let secondRecorder = FrameRecorder()
                _ = try await testClient.ws("/ws", configuration: WSGameplayClient.wsConfig(), logger: logger) { inbound, outbound, _ in
                    try await WSGameplayClient.loginOnly(nickname: nickname, on: outbound)
                    try await WSGameplayClient.drainUntilJoinComplete(inbound: inbound, recorder: secondRecorder)
                    try await outbound.close(.normalClosure, reason: nil)
                }
                let reloaded = try #require(await secondRecorder.snapshot().compactMap(IntegrationTestFixtures.energyPayload(of:)).first)
                #expect(reloaded == baseline)

                let postSession2Character = try await CharacterCheckpointPoller.waitForFreshCheckpoint(
                    characters: characters,
                    nickname: nickname,
                    after: session1LastSeen.lastSeen
                )
                #expect(
                    postSession2Character.energy == baseline,
                    "post-session-2 persisted Character.energy must round-trip the baseline, got \(postSession2Character.energy)"
                )
            }
        }
    }
}
