import Foundation
import Logging
import PostgresNIO
import SomnioCore
import SomnioData
import SomnioServerCore
import Testing

@Suite(.requiresContainerRuntime)
struct OrphanNPCDialogStatePruneTests {
    @Test func `prune keeps valid rows, deletes orphans, and logs the summary`() async throws {
        try await TestHarness.withDatabase { client in
            let handler = CapturingLogHandler()
            let logger = Logger(label: "test.orphan-prune") { _ in handler }
            let repo = PostgresNPCDialogStateRepository(client: client, logger: logger)

            // "A" loads with 2 NPCs (valid indices 1, 2). Seed two valid rows, an out-of-range row in
            // "A", and a row for a sector no longer loaded.
            try await repo.upsert(NPCDialogState(sectorName: "A", npcIndex: 1, scriptStep: 1))
            try await repo.upsert(NPCDialogState(sectorName: "A", npcIndex: 2, scriptStep: 1))
            try await repo.upsert(NPCDialogState(sectorName: "A", npcIndex: 3, scriptStep: 1))
            try await repo.upsert(NPCDialogState(sectorName: "gone", npcIndex: 1, scriptStep: 1))

            try await OrphanNPCDialogStatePrune(npcDialogStates: repo, logger: logger).prune(
                loadedSectors: ["A": makeSector(name: "A", npcCount: 2)],
                allowLargePrune: false
            )

            #expect(try await repo.find(sectorName: "A", npcIndex: 1) != nil)
            #expect(try await repo.find(sectorName: "A", npcIndex: 2) != nil)
            #expect(try await repo.find(sectorName: "A", npcIndex: 3) == nil)
            #expect(try await repo.find(sectorName: "gone", npcIndex: 1) == nil)
            #expect(handler.infoLines.contains { $0.contains("prune complete") && $0.contains("pruned=2") })
        }
    }

    @Test func `guard aborts the large prune until forced`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.orphan-prune.guard")
            let repo = PostgresNPCDialogStateRepository(client: client, logger: logger)

            // 40 rows, none in a loaded sector, so every row is an orphan and the guard trips.
            for index in 1 ... 40 {
                try await repo.upsert(NPCDialogState(sectorName: "ghost", npcIndex: Int16(index), scriptStep: 1))
            }
            let prune = OrphanNPCDialogStatePrune(npcDialogStates: repo, logger: logger)

            await #expect(throws: ServerStartupError.dialogPruneGuardTripped(orphanCount: 40, totalCount: 40)) {
                try await prune.prune(loadedSectors: [:], allowLargePrune: false)
            }
            #expect(try await repo.find(sectorName: "ghost", npcIndex: 1) != nil)

            try await prune.prune(loadedSectors: [:], allowLargePrune: true)
            #expect(try await repo.allKeys().isEmpty)
        }
    }

    // MARK: - Helpers

    private func makeSector(name: String, npcCount: Int) -> Sector {
        let npcs = (0 ..< npcCount).map { _ in
            NPC(
                spawnOrigin: GridPoint(x: 0, y: 0),
                spawnBoxSize: GridSize(width: 32, height: 48),
                maskSize: GridSize(width: 32, height: 48),
                name: "test-npc",
                figure: 0,
                facing: Heading(cardinal: .south),
                behaviorTag: 0,
                dialogScript: ""
            )
        }
        let body = SectorBody(
            version: 3,
            dimensions: GridSize(width: 8, height: 8),
            floorMaterialID: "grass-meadow",
            light: LightSetting(indoor: false, brightness: 100),
            objects: [],
            collisionMasks: [],
            portals: [],
            npcs: npcs,
            monsterSpawns: []
        )
        return Sector(body: body, name: name)
    }
}
