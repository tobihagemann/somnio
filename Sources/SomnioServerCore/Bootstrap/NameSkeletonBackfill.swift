import Foundation
import Logging
import PostgresNIO
import SomnioCore

/// Populates `name_skeleton` / `name_skeleton_version` for `accounts` and `characters` rows that
/// predate migration v6 (or were written under an older `NamePolicy.skeletonAlgorithmVersion`).
/// Runs once, synchronously, on the server readiness path right after migrations — so boot blocks
/// until it completes and `/health` reports ready only afterwards. For a near-empty deployment this
/// is negligible; an operator with a large existing table should expect a slower first boot after
/// the migration lands.
///
/// The pass is idempotent and version-gated: it only touches rows whose stored version is missing or
/// behind `current`, so a later Unicode/algorithm bump (which bumps `skeletonAlgorithmVersion`)
/// automatically recomputes stale skeletons on the next boot.
///
/// Two rows whose names skeleton-collide cannot both be backfilled (the partial UNIQUE index forbids
/// it). Rather than crash boot, the colliding rows are left un-backfilled — the confusable defense is
/// disabled *for those rows only* — and a loud, row-identifying operational error is logged. Such
/// collisions recur on every boot until an operator renames one row in each group, so the log stays
/// actionable.
public struct NameSkeletonBackfill {
    /// Rows pulled per keyset page. Bounds the per-round-trip result size on a large table.
    private static let pageSize = 500
    /// Rows updated per write transaction.
    private static let writeBatchSize = 100

    private let client: PostgresClient
    private let logger: Logger

    public init(client: PostgresClient, logger: Logger) {
        self.client = client
        self.logger = logger
    }

    public func reconcile() async throws {
        for table in ["accounts", "characters"] {
            try await reconcileTable(table)
        }
    }

    private struct Candidate {
        let id: UUID
        let name: String
        let skeleton: String
    }

    private func reconcileTable(_ table: String) async throws {
        let candidates = try await loadCandidates(table)
        guard !candidates.isEmpty else {
            logger.info("name skeleton backfill: nothing to do", metadata: ["table": "\(table)"])
            return
        }

        // Null out the stale (older-version) skeletons up front so their now-obsolete values can't
        // block the recomputed ones in the partial unique index. Without this, an algorithm bump that
        // swaps two rows' skeletons (A's new value equals B's old value and vice versa) would deadlock:
        // each row's UPDATE hits 23505 on the other's stale value, even row-by-row, leaving both stale
        // forever. After this clear, the only non-NULL skeletons left are current-version owners.
        try await clearStaleSkeletons(table)

        let collidingSkeletons = try await collidingSkeletons(in: candidates, table: table)
        logCollisions(collidingSkeletons, among: candidates, table: table)

        let updatable = candidates.filter { !collidingSkeletons.contains($0.skeleton) }
        var updated = 0
        var skipped = candidates.count - updatable.count
        for start in stride(from: 0, to: updatable.count, by: Self.writeBatchSize) {
            let chunk = Array(updatable[start ..< min(start + Self.writeBatchSize, updatable.count)])
            let outcome = try await updateBatch(chunk, table: table)
            updated += outcome.updated
            skipped += outcome.skipped
        }
        logger.info(
            "name skeleton backfill complete",
            metadata: ["table": "\(table)", "updated": "\(updated)", "skipped": "\(skipped)"]
        )
    }

    /// Sets `name_skeleton`/`name_skeleton_version` back to NULL for every row carrying an
    /// older-version (now-obsolete) skeleton, so those values stop occupying the partial unique index
    /// before the recomputed values are written. NULL-skeleton candidates are already clear.
    private func clearStaleSkeletons(_ table: String) async throws {
        let current = Int32(NamePolicy.skeletonAlgorithmVersion)
        try await client.query(
            """
            UPDATE \(unescaped: table) SET name_skeleton = NULL, name_skeleton_version = NULL
            WHERE name_skeleton IS NOT NULL AND (name_skeleton_version IS NULL OR name_skeleton_version < \(current))
            """,
            logger: logger
        )
    }

    // MARK: - Load (keyset pagination)

    private func loadCandidates(_ table: String) async throws -> [Candidate] {
        let current = Int32(NamePolicy.skeletonAlgorithmVersion)
        var candidates: [Candidate] = []
        var cursor: UUID?
        while true {
            let page = try await loadPage(table: table, current: current, after: cursor)
            guard !page.isEmpty else { break }
            for (id, name) in page {
                candidates.append(Candidate(id: id, name: name, skeleton: NamePolicy.confusableSkeleton(name)))
            }
            cursor = page.last?.0
            if page.count < Self.pageSize { break }
        }
        return candidates
    }

    /// Keyset pagination by `id` (a random UUID PK): order by `id` and carry the last-seen id as the
    /// cursor. OFFSET would skip rows because an updated row drops out of the predicate between pages.
    private func loadPage(table: String, current: Int32, after cursor: UUID?) async throws -> [(UUID, String)] {
        let limit = Self.pageSize
        let rows: PostgresRowSequence = if let cursor {
            try await client.query(
                """
                SELECT id, name FROM \(unescaped: table)
                WHERE (name_skeleton IS NULL OR name_skeleton_version IS NULL OR name_skeleton_version < \(current))
                  AND id > \(cursor)
                ORDER BY id LIMIT \(limit)
                """,
                logger: logger
            )
        } else {
            try await client.query(
                """
                SELECT id, name FROM \(unescaped: table)
                WHERE (name_skeleton IS NULL OR name_skeleton_version IS NULL OR name_skeleton_version < \(current))
                ORDER BY id LIMIT \(limit)
                """,
                logger: logger
            )
        }
        var page: [(UUID, String)] = []
        for try await row in rows.decode((UUID, String).self) {
            page.append(row)
        }
        return page
    }

    // MARK: - Collision detection (full-table grouping)

    /// A full-table pass, independent of the paged write loop: two colliding rows can land in
    /// different id-ordered batches, so a per-batch grouping would miss them. A skeleton collides if
    /// two or more candidates compute it, or if a single candidate computes one an already-populated
    /// row already owns.
    private func collidingSkeletons(in candidates: [Candidate], table: String) async throws -> Set<String> {
        var bySkeleton: [String: Int] = [:]
        for candidate in candidates {
            bySkeleton[candidate.skeleton, default: 0] += 1
        }
        var colliding: Set<String> = []
        for (skeleton, count) in bySkeleton {
            if count >= 2 {
                colliding.insert(skeleton)
            } else if try await existingOwnerExists(table: table, skeleton: skeleton) {
                colliding.insert(skeleton)
            }
        }
        return colliding
    }

    /// Whether an already-reconciled row (current version) owns `skeleton`. Gating on
    /// `name_skeleton_version = current` is what excludes the candidate's own row and every other
    /// candidate (all of which carry a NULL or older version): otherwise, on an algorithm bump, a
    /// stale row whose recomputed skeleton is unchanged would match itself, be flagged colliding, and
    /// never advance its version -- looping forever.
    private func existingOwnerExists(table: String, skeleton: String) async throws -> Bool {
        let current = Int32(NamePolicy.skeletonAlgorithmVersion)
        let rows = try await client.query(
            """
            SELECT 1 FROM \(unescaped: table)
            WHERE name_skeleton = \(skeleton) AND name_skeleton_version = \(current) LIMIT 1
            """,
            logger: logger
        )
        for try await _ in rows.decode(Int.self) {
            return true
        }
        return false
    }

    private func logCollisions(_ skeletons: Set<String>, among candidates: [Candidate], table: String) {
        guard !skeletons.isEmpty else { return }
        var rowsBySkeleton: [String: [Candidate]] = [:]
        for candidate in candidates where skeletons.contains(candidate.skeleton) {
            rowsBySkeleton[candidate.skeleton, default: []].append(candidate)
        }
        for (skeleton, rows) in rowsBySkeleton {
            let collidingRows = rows.map { "\($0.id)=\($0.name)" }.joined(separator: ", ")
            logger.error(
                """
                name skeleton collision; leaving rows un-backfilled (confusable defense disabled for \
                them until an operator renames one). Recurs every boot until resolved.
                """,
                metadata: [
                    "table": "\(table)",
                    "skeleton": "\(skeleton)",
                    "rows": "\(collidingRows)"
                ]
            )
        }
    }

    // MARK: - Write (batched, with a per-row collision backstop)

    private func updateBatch(_ chunk: [Candidate], table: String) async throws -> (updated: Int, skipped: Int) {
        let logger = logger
        let version = Int32(NamePolicy.skeletonAlgorithmVersion)
        do {
            try await client.withTransaction(logger: logger) { connection in
                for candidate in chunk {
                    try await connection.query(
                        """
                        UPDATE \(unescaped: table) SET name_skeleton = \(candidate.skeleton), \
                        name_skeleton_version = \(version) WHERE id = \(candidate.id)
                        """,
                        logger: logger
                    )
                }
            }
            return (chunk.count, 0)
        } catch {
            // A 23505 here is one the preflight pass didn't account for (e.g. a row inserted
            // concurrently). The whole transaction rolled back, so retry the batch row-by-row and
            // fold any individual collision into the same degraded-boot log rather than crashing.
            guard isUniqueViolation(error) else { throw error }
            var updated = 0
            var skipped = 0
            for candidate in chunk {
                do {
                    try await client.query(
                        """
                        UPDATE \(unescaped: table) SET name_skeleton = \(candidate.skeleton), \
                        name_skeleton_version = \(version) WHERE id = \(candidate.id)
                        """,
                        logger: logger
                    )
                    updated += 1
                } catch {
                    guard isUniqueViolation(error) else { throw error }
                    logger.error(
                        "name skeleton collision at write time; row left un-backfilled",
                        metadata: ["table": "\(table)", "id": "\(candidate.id)", "name": "\(candidate.name)"]
                    )
                    skipped += 1
                }
            }
            return (updated, skipped)
        }
    }

    private func isUniqueViolation(_ error: any Error) -> Bool {
        let underlying: any Error = if let transactionError = error as? PostgresTransactionError, let closureError = transactionError.closureError {
            closureError
        } else {
            error
        }
        guard let psqlError = underlying as? PSQLError else { return false }
        return psqlError.serverInfo?[.sqlState] == "23505"
    }
}
