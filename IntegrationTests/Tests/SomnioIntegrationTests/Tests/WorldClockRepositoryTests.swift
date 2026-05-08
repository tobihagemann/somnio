import Logging
import SomnioCore
import SomnioData
import Testing

@Suite(.requiresContainerRuntime)
struct WorldClockRepositoryTests {
    @Test func `empty table returns boot default`() async throws {
        try await TestHarness.withDatabase { client in
            let repo = PostgresWorldClockRepository(client: client, logger: Logger(label: "test.worldclock"))
            let loaded = try await repo.load()
            #expect(loaded == WorldClock.bootDefault)
        }
    }

    @Test func `save then load preserves all six fields`() async throws {
        try await TestHarness.withDatabase { client in
            let repo = PostgresWorldClockRepository(client: client, logger: Logger(label: "test.worldclock.save"))
            let snapshot = WorldClock(second: 42, minute: 17, hour: 23, day: 7, month: 4, year: 612)
            try await repo.save(snapshot)
            let loaded = try await repo.load()
            #expect(loaded == snapshot)
        }
    }

    @Test func `save twice updates the single row`() async throws {
        try await TestHarness.withDatabase { client in
            let repo = PostgresWorldClockRepository(client: client, logger: Logger(label: "test.worldclock.upsert"))
            try await repo.save(WorldClock(second: 1, minute: 1, hour: 1, day: 1, month: 1, year: 500))
            let updated = WorldClock(second: 2, minute: 2, hour: 2, day: 2, month: 2, year: 501)
            try await repo.save(updated)
            #expect(try await repo.load() == updated)
        }
    }
}
