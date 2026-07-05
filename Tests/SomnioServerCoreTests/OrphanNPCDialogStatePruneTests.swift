import Foundation
import Logging
import SomnioCore
import SomnioData
import Testing
@testable import SomnioServerCore

struct OrphanNPCDialogStatePruneTests {
    @Test func `keeps in-range rows and prunes out-of-range, unloaded, and zero-NPC sector rows`() async throws {
        // Loaded: "A" with 2 NPCs (valid indices 1, 2) and "empty" with 0 NPCs (no valid indices).
        // Stored rows mix valid in-range, an out-of-range index in a loaded sector, a row for an
        // unloaded sector, and a row for the zero-NPC loaded sector.
        let repo = RecordingDialogRepository(stored: [
            NPCDialogStateKey(sectorName: "A", npcIndex: 1),
            NPCDialogStateKey(sectorName: "A", npcIndex: 2),
            NPCDialogStateKey(sectorName: "A", npcIndex: 3),
            NPCDialogStateKey(sectorName: "gone", npcIndex: 1),
            NPCDialogStateKey(sectorName: "empty", npcIndex: 1)
        ])
        let prune = OrphanNPCDialogStatePrune(npcDialogStates: repo, logger: Logger(label: "test.prune"))

        try await prune.prune(
            loadedSectors: ["A": makeSector(name: "A", npcCount: 2), "empty": makeSector(name: "empty", npcCount: 0)],
            allowLargePrune: false
        )

        let deleted = await Set(repo.deletedSnapshot())
        #expect(deleted == [
            NPCDialogStateKey(sectorName: "A", npcIndex: 3),
            NPCDialogStateKey(sectorName: "gone", npcIndex: 1),
            NPCDialogStateKey(sectorName: "empty", npcIndex: 1)
        ])
    }

    @Test func `empty table prunes nothing without throwing`() async throws {
        let repo = RecordingDialogRepository(stored: [])
        let prune = OrphanNPCDialogStatePrune(npcDialogStates: repo, logger: Logger(label: "test.prune.empty"))

        try await prune.prune(loadedSectors: ["A": makeSector(name: "A", npcCount: 2)], allowLargePrune: false)

        #expect(await repo.deletedSnapshot().isEmpty)
        #expect(await repo.deleteCallCount == 1)
    }

    @Test func `guard trips and deletes nothing when orphans exceed the threshold`() async throws {
        // All 40 rows orphaned (no loaded sectors): 40 >= floor and 40*2 >= 40, so the guard trips.
        let repo = RecordingDialogRepository(stored: ghostKeys(count: 40))
        let prune = OrphanNPCDialogStatePrune(npcDialogStates: repo, logger: Logger(label: "test.prune.guard"))

        await #expect(throws: ServerStartupError.dialogPruneGuardTripped(orphanCount: 40, totalCount: 40)) {
            try await prune.prune(loadedSectors: [:], allowLargePrune: false)
        }
        #expect(await repo.deleteCallCount == 0)
    }

    @Test func `force override proceeds through a large prune`() async throws {
        let repo = RecordingDialogRepository(stored: ghostKeys(count: 40))
        let prune = OrphanNPCDialogStatePrune(npcDialogStates: repo, logger: Logger(label: "test.prune.force"))

        try await prune.prune(loadedSectors: [:], allowLargePrune: true)

        #expect(await repo.deletedSnapshot().count == 40)
    }

    @Test func `absolute floor lets a small all-orphan table prune without tripping`() async throws {
        // 19 all-orphan rows is below the floor of 20, so the guard never engages despite the
        // 100%-orphan majority.
        let repo = RecordingDialogRepository(stored: ghostKeys(count: 19))
        let prune = OrphanNPCDialogStatePrune(npcDialogStates: repo, logger: Logger(label: "test.prune.floor"))

        try await prune.prune(loadedSectors: [:], allowLargePrune: false)

        #expect(await repo.deletedSnapshot().count == 19)
    }

    /// The half-of-total boundary — `orphans >= floor && orphans*2 >= total` — with totals straddling
    /// the exact-half line, including the 21/41 case the old float threshold let through unguarded.
    @Test(arguments: [
        (validCount: 20, orphanCount: 21, expectTrip: true), // total 41: 42 >= 41
        (validCount: 21, orphanCount: 20, expectTrip: false), // total 41: 40 < 41
        (validCount: 20, orphanCount: 20, expectTrip: true), // total 40: 40 >= 40
        (validCount: 22, orphanCount: 21, expectTrip: false) // total 43: 42 < 43
    ]) func `half-of-total boundary trips exactly per the integer rule`(
        validCount: Int,
        orphanCount: Int,
        expectTrip: Bool
    ) async throws {
        // Valid keys live in a loaded sector "valid" with `validCount` NPCs; orphans live in the
        // unloaded "ghost" sector. Total = validCount + orphanCount.
        let validKeys = PerSectorActor.npcEntityIndices(count: validCount)
            .map { NPCDialogStateKey(sectorName: "valid", npcIndex: $0) }
        let repo = RecordingDialogRepository(stored: validKeys + ghostKeys(count: orphanCount))
        let prune = OrphanNPCDialogStatePrune(npcDialogStates: repo, logger: Logger(label: "test.prune.boundary"))
        let loadedSectors = ["valid": makeSector(name: "valid", npcCount: validCount)]

        if expectTrip {
            await #expect(throws: ServerStartupError.dialogPruneGuardTripped(
                orphanCount: orphanCount,
                totalCount: validCount + orphanCount
            )) {
                try await prune.prune(loadedSectors: loadedSectors, allowLargePrune: false)
            }
            #expect(await repo.deleteCallCount == 0)
        } else {
            try await prune.prune(loadedSectors: loadedSectors, allowLargePrune: false)
            #expect(await repo.deletedSnapshot().count == orphanCount)
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
            ground: GroundTile(tilesetIndex: 0, sourceX: 0, sourceY: 0),
            light: LightSetting(indoor: false, brightness: 100),
            objects: [],
            collisionMasks: [],
            portals: [],
            npcs: npcs,
            monsterSpawns: []
        )
        return Sector(body: body, name: name)
    }

    private func ghostKeys(count: Int) -> [NPCDialogStateKey] {
        (1 ... count).map { NPCDialogStateKey(sectorName: "ghost", npcIndex: Int16($0)) }
    }
}

/// Stub returning a fixed `allKeys()` set and recording the `deleteOrphans(_:)` argument, so the
/// prune's derivation + guard can be asserted without Postgres.
private actor RecordingDialogRepository: NPCDialogStateRepository {
    private let stored: [NPCDialogStateKey]
    private var deleted: [NPCDialogStateKey] = []
    private(set) var deleteCallCount = 0

    init(stored: [NPCDialogStateKey]) {
        self.stored = stored
    }

    func find(sectorName _: String, npcIndex _: Int16) async throws -> NPCDialogState? {
        nil
    }

    func loadAll(sectorName _: String) async throws -> [NPCDialogState] {
        []
    }

    func allKeys() async throws -> [NPCDialogStateKey] {
        stored
    }

    func upsert(_: NPCDialogState) async throws {}
    func reset(sectorName _: String, npcIndex _: Int16) async throws {}

    func deleteOrphans(_ keys: [NPCDialogStateKey]) async throws {
        deleteCallCount += 1
        deleted.append(contentsOf: keys)
    }

    func deletedSnapshot() -> [NPCDialogStateKey] {
        deleted
    }
}
