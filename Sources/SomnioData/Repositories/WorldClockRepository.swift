import Foundation
import Logging
import PostgresNIO
import SomnioCore

public protocol WorldClockRepository: Sendable {
    func load() async throws -> WorldClock
    func save(_ clock: WorldClock) async throws
}

public actor PostgresWorldClockRepository: WorldClockRepository {
    private let client: PostgresClient
    private let logger: Logger

    public init(client: PostgresClient, logger: Logger) {
        self.client = client
        self.logger = logger
    }

    /// Returns `WorldClock.bootDefault` when `world_clock` is empty so a fresh deployment
    /// boots from the deterministic seed time without a separate one-shot seeder.
    public func load() async throws -> WorldClock {
        let rows = try await client.query(
            """
            SELECT second, minute, hour, day, month, year
            FROM world_clock
            WHERE id = TRUE
            """,
            logger: logger
        )
        for try await row in rows {
            return try row.decodeWorldClock()
        }
        return WorldClock.bootDefault
    }

    public func save(_ clock: WorldClock) async throws {
        try await client.query(
            """
            INSERT INTO world_clock (id, second, minute, hour, day, month, year)
            VALUES (TRUE, \(clock.second), \(clock.minute), \(clock.hour), \(clock.day), \(clock.month), \(clock.year))
            ON CONFLICT (id) DO UPDATE SET
                second = EXCLUDED.second,
                minute = EXCLUDED.minute,
                hour = EXCLUDED.hour,
                day = EXCLUDED.day,
                month = EXCLUDED.month,
                year = EXCLUDED.year
            """,
            logger: logger
        )
    }
}

private extension PostgresRow {
    func decodeWorldClock() throws -> WorldClock {
        let (second, minute, hour, day, month, year) = try decode(
            (Int16, Int16, Int16, Int16, Int16, Int16).self
        )
        return WorldClock(
            second: second,
            minute: minute,
            hour: hour,
            day: day,
            month: month,
            year: year
        )
    }
}
