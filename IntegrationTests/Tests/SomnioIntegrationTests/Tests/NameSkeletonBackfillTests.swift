import Foundation
import Logging
import PostgresNIO
import SomnioCore
import SomnioServerCore
import Testing

@Suite(.requiresContainerRuntime)
struct NameSkeletonBackfillTests {
    @Test func `backfill populates skeletons for legacy null rows`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.backfill")
            let alice = UUID()
            let bob = UUID()
            try await insertAccount(client, id: alice, name: "alice", logger: logger)
            try await insertAccount(client, id: bob, name: "bob", logger: logger)

            try await NameSkeletonBackfill(client: client, logger: logger).reconcile()

            #expect(try await storedSkeleton(client, id: alice, logger: logger) == NamePolicy.confusableSkeleton("alice"))
            #expect(try await storedSkeleton(client, id: bob, logger: logger) == NamePolicy.confusableSkeleton("bob"))
        }
    }

    @Test func `backfill recomputes stale-version rows and advances unchanged ones`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.backfill.recompute")
            let current = Int32(NamePolicy.skeletonAlgorithmVersion)
            let stale = UUID()
            let unchanged = UUID()
            // A row written under an older algorithm version with a now-wrong skeleton.
            try await insertAccount(client, id: stale, name: "carol", skeleton: "stale-skeleton", version: 0, logger: logger)
            // A row at an older version whose recomputed skeleton is identical: it must still advance
            // its version and must NOT be mistaken for a collision against itself.
            try await insertAccount(
                client, id: unchanged, name: "dave",
                skeleton: NamePolicy.confusableSkeleton("dave"), version: 0, logger: logger
            )

            try await NameSkeletonBackfill(client: client, logger: logger).reconcile()

            #expect(try await storedSkeleton(client, id: stale, logger: logger) == NamePolicy.confusableSkeleton("carol"))
            #expect(try await storedVersion(client, id: stale, logger: logger) == current)
            #expect(try await storedSkeleton(client, id: unchanged, logger: logger) == NamePolicy.confusableSkeleton("dave"))
            #expect(try await storedVersion(client, id: unchanged, logger: logger) == current)
        }
    }

    @Test func `backfill skips a legacy row colliding with an already-populated owner`() async throws {
        try await TestHarness.withDatabase { client in
            let handler = CapturingLogHandler()
            let logger = Logger(label: "test.backfill.existing-owner") { _ in handler }
            let current = Int32(NamePolicy.skeletonAlgorithmVersion)
            let owner = UUID()
            let legacy = UUID()
            // Latin "ADMIN" already reconciled at the current version; Cyrillic "АDMIN" is a legacy
            // NULL row whose skeleton collides with it.
            try await insertAccount(
                client, id: owner, name: "ADMIN",
                skeleton: NamePolicy.confusableSkeleton("ADMIN"), version: current, logger: logger
            )
            try await insertAccount(client, id: legacy, name: "\u{0410}DMIN", logger: logger)

            try await NameSkeletonBackfill(client: client, logger: logger).reconcile()

            // The legacy row stays un-backfilled; the owner is untouched.
            #expect(try await storedSkeleton(client, id: legacy, logger: logger) == nil)
            #expect(try await storedSkeleton(client, id: owner, logger: logger) == NamePolicy.confusableSkeleton("ADMIN"))
            #expect(handler.errorLines.contains { $0.contains("collision") && $0.contains(legacy.uuidString) })
        }
    }

    @Test func `backfill leaves mutually-colliding rows null and logs without crashing`() async throws {
        try await TestHarness.withDatabase { client in
            let handler = CapturingLogHandler()
            let logger = Logger(label: "test.backfill.collision") { _ in handler }
            let latin = UUID()
            let cyrillic = UUID()
            // Two legacy NULL rows that skeleton-collide with each other.
            try await insertAccount(client, id: latin, name: "ADMIN", logger: logger)
            try await insertAccount(client, id: cyrillic, name: "\u{0410}DMIN", logger: logger)

            // Must not crash boot.
            try await NameSkeletonBackfill(client: client, logger: logger).reconcile()

            #expect(try await storedSkeleton(client, id: latin, logger: logger) == nil)
            #expect(try await storedSkeleton(client, id: cyrillic, logger: logger) == nil)
            #expect(handler.errorLines.contains { $0.contains("collision") })
            #expect(handler.errorLines.contains { $0.contains(latin.uuidString) && $0.contains(cyrillic.uuidString) })
        }
    }

    // MARK: - Helpers

    private func insertAccount(
        _ client: PostgresClient,
        id: UUID,
        name: String,
        skeleton: String? = nil,
        version: Int32? = nil,
        logger: Logger
    ) async throws {
        try await client.query(
            """
            INSERT INTO accounts (id, name, password_hash, email, name_skeleton, name_skeleton_version)
            VALUES (\(id), \(name), \("hash"), \("legacy@example.com"), \(skeleton), \(version))
            """,
            logger: logger
        )
    }

    private func storedSkeleton(_ client: PostgresClient, id: UUID, logger: Logger) async throws -> String? {
        let rows = try await client.query("SELECT name_skeleton FROM accounts WHERE id = \(id)", logger: logger)
        for try await value in rows.decode(String?.self) {
            return value
        }
        return nil
    }

    private func storedVersion(_ client: PostgresClient, id: UUID, logger: Logger) async throws -> Int32? {
        let rows = try await client.query("SELECT name_skeleton_version FROM accounts WHERE id = \(id)", logger: logger)
        for try await value in rows.decode(Int32?.self) {
            return value
        }
        return nil
    }
}
