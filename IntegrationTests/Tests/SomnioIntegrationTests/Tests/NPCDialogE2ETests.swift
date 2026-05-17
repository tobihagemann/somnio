import Foundation
import Logging
import PostgresNIO
import SomnioCore
import SomnioData
import SomnioProtocol
import SomnioServerCore
import Testing

struct NPCDialogE2ETests {
    // swiftlint:disable:next function_body_length
    @Test func `repeated AI ticks walk the dialog cursor across all script steps then wrap`() async throws {
        let logger = Logger(label: "test.npc-dialog.cursor")
        let sectors = try IntegrationTestFixtures.defaultSectors()
        let bibliothek = try #require(sectors["EdariaBibliothek"])
        let libus = try #require(bibliothek.npcs.first)
        let nickname = "dialog-\(UUID().uuidString.prefix(6))"
        let scriptSteps = libus.dialogSteps
        try #require(scriptSteps.count >= 2)

        let actor = PerSectorActor(staticSector: bibliothek, logger: logger)
        let outbox = ConnectionOutbox(highWatermark: 1024)
        let sink = FrameRecorder()
        let drainTask = startOutboxDrain(outbox: outbox, into: sink)

        let libusEntityIndex: Int16 = 1
        let entityIndex = try await PerSectorActorClient.attachPlayer(
            actor: actor,
            nickname: nickname,
            sector: bibliothek,
            position: NPCPlacement.runtimePosition(for: libus),
            outbox: outbox
        )

        var digests: [AITickDigest] = []
        await actor.handleBumpNPC(npcIndex: libusEntityIndex, from: entityIndex)
        await digests.append(actor.runAITick())
        for _ in 1 ..< scriptSteps.count {
            for _ in 0 ..< 59 {
                await digests.append(actor.runAITick())
            }
            await digests.append(actor.runAITick())
        }

        // Wrap: targeting cleared on final step. Cooldown was reset to 0 by the emit,
        // so re-bump and drive a full cooldown cycle (59 advances + 1 emit) before the
        // restart emit lands. A single post-bump tick would only advance cooldown to 1.
        await actor.handleBumpNPC(npcIndex: libusEntityIndex, from: entityIndex)
        for _ in 0 ..< 59 {
            await digests.append(actor.runAITick())
        }
        await digests.append(actor.runAITick())

        outbox.finish()
        await drainTask.value
        let frames = await sink.snapshot()
        let says = frames
            .compactMap(IntegrationTestFixtures.serverSayPayload(of:))
            .filter { $0.entityIndex == libusEntityIndex }
        let expected = scriptSteps.map { $0.replacingOccurrences(of: "$name", with: nickname) }
        #expect(says.count == expected.count + 1, "expected one Say per step plus the post-wrap restart Say, got \(says.count)")
        for (index, expectedText) in expected.enumerated() {
            #expect(says[index].text == expectedText)
        }
        #expect(says.last?.text == expected.first, "post-wrap re-bump must restart at step 1")

        let upserts = digests.flatMap(\.dialogUpserts)
        let resets = digests.flatMap(\.dialogResets)
        // First pass: (N-1) advance emits each produce an upsert; the final emit wraps
        // and produces a reset, not an upsert. Post-wrap restart adds one more advance
        // emit (step 1 → step 2 upsert). Total upserts: (N-1) + 1 = N.
        #expect(upserts.count == scriptSteps.count, "non-final emits advance the cursor with an upsert; the restart emit adds one more")
        #expect(resets.count == 1, "final emit wraps and emits exactly one reset")
        #expect(resets.first?.npcIndex == libusEntityIndex)
        #expect(resets.first?.sectorName == bibliothek.name)
    }

    @Test func `BumpNPC outside interaction radius produces no Say or dialog upsert`() async throws {
        let logger = Logger(label: "test.npc-dialog.out-of-radius")
        let sectors = try IntegrationTestFixtures.defaultSectors()
        let bibliothek = try #require(sectors["EdariaBibliothek"])
        let libus = try #require(bibliothek.npcs.first)
        let nickname = "outsider-\(UUID().uuidString.prefix(6))"

        let actor = PerSectorActor(staticSector: bibliothek, logger: logger)
        let outbox = ConnectionOutbox(highWatermark: 1024)
        let sink = FrameRecorder()
        let drainTask = startOutboxDrain(outbox: outbox, into: sink)

        let libusRuntime = NPCPlacement.runtimePosition(for: libus)
        let farPosition = GridPoint(
            x: Int16(clamping: Int32(libusRuntime.x) + 400),
            y: libusRuntime.y
        )
        let entityIndex = try await PerSectorActorClient.attachPlayer(
            actor: actor,
            nickname: nickname,
            sector: bibliothek,
            position: farPosition,
            outbox: outbox
        )

        await actor.handleBumpNPC(npcIndex: 1, from: entityIndex)
        var digests: [AITickDigest] = []
        for _ in 0 ..< 5 {
            await digests.append(actor.runAITick())
        }

        outbox.finish()
        await drainTask.value
        let frames = await sink.snapshot()
        let saysFromLibus = frames
            .compactMap(IntegrationTestFixtures.serverSayPayload(of:))
            .filter { $0.entityIndex == 1 }
        #expect(saysFromLibus.isEmpty, "out-of-radius bump must not emit Libus dialog, got \(saysFromLibus.map(\.text))")
        // Pre-compute the bool so the next `swiftformat` pass cannot rewrite the predicate
        // into a key-path inside `#expect` — that form expands as a `rethrows` call without
        // a `try` and fails to compile under the Swift Testing macro.
        let upsertsAllEmpty = digests.allSatisfy(\.dialogUpserts.isEmpty)
        #expect(upsertsAllEmpty, "out-of-radius bump must not produce upserts")
    }

    @Test(.requiresContainerRuntime)
    // swiftlint:disable:next function_body_length
    func `NPC dialog cursor persists across server restart via direct repository writes`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.npc-dialog.persistence")
            let sectors = try IntegrationTestFixtures.defaultSectors()
            let bibliothek = try #require(sectors["EdariaBibliothek"])
            let libus = try #require(bibliothek.npcs.first)
            try #require(libus.dialogSteps.count >= 3, "Test 3 requires Libus to ship at least 3 dialog steps so a mid-script restart is observable")
            let nickname = "resumer-\(UUID().uuidString.prefix(6))"
            let dialogStates = PostgresNPCDialogStateRepository(client: client, logger: logger)
            let libusEntityIndex: Int16 = 1
            let libusRuntime = NPCPlacement.runtimePosition(for: libus)

            // Rig 1: bump + drive cursor to the post-step-2 state, applying each digest
            // through the repository so the persistence path matches what
            // `WorldRouter.runAITickAcrossSectors` does in production.
            do {
                let actor = PerSectorActor(staticSector: bibliothek, logger: logger)
                let outbox = ConnectionOutbox(highWatermark: 1024)
                let sink = FrameRecorder()
                let drainTask = startOutboxDrain(outbox: outbox, into: sink)
                let entityIndex = try await PerSectorActorClient.attachPlayer(
                    actor: actor,
                    nickname: nickname,
                    sector: bibliothek,
                    position: libusRuntime,
                    outbox: outbox
                )
                await actor.handleBumpNPC(npcIndex: libusEntityIndex, from: entityIndex)
                try await applyDigest(actor.runAITick(), to: dialogStates)
                for _ in 0 ..< 59 {
                    try await applyDigest(actor.runAITick(), to: dialogStates)
                }
                try await applyDigest(actor.runAITick(), to: dialogStates)
                outbox.finish()
                await drainTask.value
            }

            let persistedStates = try await dialogStates.loadAll(sectorName: bibliothek.name)
            let libusState = try #require(persistedStates.first { $0.npcIndex == libusEntityIndex })
            #expect(libusState.scriptStep == 3, "post-emit-2 persisted cursor must read 3 (1-based)")

            let cursors = Dictionary(uniqueKeysWithValues: persistedStates.map { ($0.npcIndex, $0.scriptStep) })
            let restartedActor = PerSectorActor(
                staticSector: bibliothek,
                logger: logger,
                initialDialogCursors: cursors
            )
            let restartedOutbox = ConnectionOutbox(highWatermark: 1024)
            let restartedSink = FrameRecorder()
            let restartedDrain = startOutboxDrain(outbox: restartedOutbox, into: restartedSink)
            let restartedEntityIndex = try await PerSectorActorClient.attachPlayer(
                actor: restartedActor,
                nickname: nickname,
                sector: bibliothek,
                position: libusRuntime,
                outbox: restartedOutbox
            )
            await restartedActor.handleBumpNPC(npcIndex: libusEntityIndex, from: restartedEntityIndex)
            _ = await restartedActor.runAITick()
            restartedOutbox.finish()
            await restartedDrain.value
            let restartedFrames = await restartedSink.snapshot()
            let restartedSays = restartedFrames
                .compactMap(IntegrationTestFixtures.serverSayPayload(of:))
                .filter { $0.entityIndex == libusEntityIndex }
            let firstAfterRestart = try #require(restartedSays.first)
            let expectedStep3 = libus.dialogSteps[2].replacingOccurrences(of: "$name", with: nickname)
            #expect(firstAfterRestart.text == expectedStep3, "restart must resume at script step 3, got \(firstAfterRestart.text)")
        }
    }

    // MARK: - Helpers

    private func applyDigest(_ digest: AITickDigest, to repository: any NPCDialogStateRepository) async throws {
        for state in digest.dialogUpserts {
            try await repository.upsert(state)
        }
        for key in digest.dialogResets {
            try await repository.reset(sectorName: key.sectorName, npcIndex: key.npcIndex)
        }
    }
}
