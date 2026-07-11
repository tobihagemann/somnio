import Foundation
import Logging
import PostgresNIO
import SomnioCore
import SomnioData
import SomnioProtocol
import SomnioServerCore
import SomnioTestSupport
import Testing

@Suite(.requiresContainerRuntime)
struct WorldRouterDialogPersistenceTests {
    @Test func `runAITickAcrossSectors persists the NPC dialog cursor through the repository`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.world-router.dialog-persistence")
            let sectors = try IntegrationTestFixtures.defaultSectors()
            let dependencies = try await IntegrationTestFixtures.makeConnectionDependencies(
                client: client,
                sectors: sectors,
                logger: logger
            )

            try await withTestTimeout(.seconds(30)) {
                let bibliothek = try #require(sectors["EdariaBibliothek"])
                let libus = try #require(bibliothek.npcs.first)
                let sector = try #require(await dependencies.worldRouter.sectorActor(named: "EdariaBibliothek"))
                // `PerSectorActor` indexes NPCs starting at 1 in the order they appear in
                // `staticSector.npcs`; the first NPC therefore corresponds to runtime
                // `npcIndex == 1`.
                let npcIndex: Int16 = 1
                let outbox = ConnectionOutbox(highWatermark: 1024)
                let entityIndex = try await PerSectorActorClient.attachPlayer(
                    actor: sector,
                    nickname: "alice",
                    sector: bibliothek,
                    position: NPCPlacement.runtimePosition(for: libus),
                    outbox: outbox
                )

                await sector.handleBumpNPC(npcIndex: npcIndex, from: entityIndex)
                await dependencies.worldRouter.runAITickAcrossSectors()

                let npcDialogStates = PostgresNPCDialogStateRepository(client: client, logger: logger)
                let state = try await npcDialogStates.find(
                    sectorName: "EdariaBibliothek",
                    npcIndex: npcIndex
                )
                let persisted = try #require(state)
                #expect(persisted.scriptStep == 2)
            }
        }
    }
}
