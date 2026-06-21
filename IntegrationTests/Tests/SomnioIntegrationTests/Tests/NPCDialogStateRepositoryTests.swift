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

    @Test func `deleteOrphans removes only the listed keys and no-ops on empty input`() async throws {
        try await TestHarness.withDatabase { client in
            let repo = PostgresNPCDialogStateRepository(client: client, logger: Logger(label: "test.npc.dialog.delete-orphans"))
            try await repo.upsert(NPCDialogState(sectorName: "EdariaBibliothek", npcIndex: 0, scriptStep: 2))
            try await repo.upsert(NPCDialogState(sectorName: "EdariaBibliothek", npcIndex: 1, scriptStep: 4))
            try await repo.upsert(NPCDialogState(sectorName: "EdariaArena", npcIndex: 0, scriptStep: 6))

            // Empty input short-circuits before opening a transaction and touches no row. Assert the
            // exact key set so `allKeys()`'s (sector_name, npc_index) decode is checked, not just its
            // cardinality.
            try await repo.deleteOrphans([])
            let allKeys = try await repo.allKeys()
            #expect(Set(allKeys) == [
                NPCDialogStateKey(sectorName: "EdariaBibliothek", npcIndex: 0),
                NPCDialogStateKey(sectorName: "EdariaBibliothek", npcIndex: 1),
                NPCDialogStateKey(sectorName: "EdariaArena", npcIndex: 0)
            ])

            try await repo.deleteOrphans([
                NPCDialogStateKey(sectorName: "EdariaBibliothek", npcIndex: 0),
                NPCDialogStateKey(sectorName: "EdariaArena", npcIndex: 0)
            ])
            #expect(try await repo.find(sectorName: "EdariaBibliothek", npcIndex: 0) == nil)
            #expect(try await repo.find(sectorName: "EdariaArena", npcIndex: 0) == nil)
            let untouched = try #require(try await repo.find(sectorName: "EdariaBibliothek", npcIndex: 1))
            #expect(untouched.scriptStep == 4)
        }
    }
}
