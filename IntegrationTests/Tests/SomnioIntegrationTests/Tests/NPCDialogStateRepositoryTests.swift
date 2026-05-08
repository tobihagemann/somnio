import Logging
import SomnioCore
import SomnioData
import Testing

@Suite(.requiresContainerRuntime)
struct NPCDialogStateRepositoryTests {
    @Test func `composite key upsert moves the cursor forward`() async throws {
        try await TestHarness.withDatabase { client in
            let repo = PostgresNPCDialogStateRepository(client: client, logger: Logger(label: "test.npc.dialog"))
            try await repo.upsert(NPCDialogState(sectorName: "EdariaBibliothek", npcIndex: 0, scriptStep: 1))
            try await repo.upsert(NPCDialogState(sectorName: "EdariaBibliothek", npcIndex: 0, scriptStep: 2))
            let loaded = try #require(try await repo.find(sectorName: "EdariaBibliothek", npcIndex: 0))
            #expect(loaded.scriptStep == 2)
        }
    }

    @Test func `reset deletes only the targeted row`() async throws {
        try await TestHarness.withDatabase { client in
            let repo = PostgresNPCDialogStateRepository(client: client, logger: Logger(label: "test.npc.dialog.reset"))
            try await repo.upsert(NPCDialogState(sectorName: "EdariaBibliothek", npcIndex: 0, scriptStep: 3))
            try await repo.upsert(NPCDialogState(sectorName: "EdariaBibliothek", npcIndex: 1, scriptStep: 5))
            try await repo.reset(sectorName: "EdariaBibliothek", npcIndex: 0)
            #expect(try await repo.find(sectorName: "EdariaBibliothek", npcIndex: 0) == nil)
            let untouched = try #require(try await repo.find(sectorName: "EdariaBibliothek", npcIndex: 1))
            #expect(untouched.scriptStep == 5)
        }
    }
}
