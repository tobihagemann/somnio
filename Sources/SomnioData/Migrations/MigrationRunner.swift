import Logging
import PostgresNIO

/// Applies pending schema migrations against a `PostgresClient` exactly once at server boot.
///
/// The runner is a plain actor rather than a `swift-service-lifecycle` `Service`: a one-shot
/// startup phase doesn't fit `Service.run()`'s "runs until termination" contract. It does
/// not own the client; the caller (server `main.swift`) hands in the canonical
/// `PostgresClient` whose own `run()` is already active inside the `ServiceGroup`.
public actor MigrationRunner {
    /// Stable bigint chosen so it's human-recognizable as ASCII "SomnioMi" inside `pg_locks`.
    /// Transaction-level advisory locks auto-release at COMMIT/ROLLBACK and serialize
    /// concurrent server replicas attempting to migrate at the same time.
    static let advisoryLockKey: Int64 = 0x536F_6D6E_696F_4D69

    private let client: PostgresClient
    private let registry: [Migration]
    private let logger: Logger

    public init(client: PostgresClient, registry: [Migration] = MigrationRegistry.all, logger: Logger) {
        self.client = client
        self.registry = registry
        self.logger = logger
    }

    /// Apply every registered migration whose version isn't already in `schema_migrations`.
    /// Wraps the entire sequence in one transaction so a partial migration set never lands.
    public func applyPending() async throws {
        let logger = logger
        let registry = registry
        try await client.withTransaction(logger: logger) { connection in
            try await Self.acquireAdvisoryLock(connection: connection, logger: logger)
            try await Self.ensureBookkeepingTable(connection: connection, logger: logger)
            let appliedVersions = try await Self.loadAppliedVersions(connection: connection, logger: logger)
            let pending = registry.filter { !appliedVersions.contains($0.version) }
            guard !pending.isEmpty else {
                logger.info("no migrations to apply")
                return
            }
            for migration in pending {
                try await Self.apply(migration, connection: connection, logger: logger)
            }
        }
    }

    private static func acquireAdvisoryLock(connection: PostgresConnection, logger: Logger) async throws {
        try await connection.query(
            "SELECT pg_advisory_xact_lock(\(advisoryLockKey))",
            logger: logger
        )
    }

    private static func ensureBookkeepingTable(connection: PostgresConnection, logger: Logger) async throws {
        try await connection.query(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """,
            logger: logger
        )
    }

    private static func loadAppliedVersions(connection: PostgresConnection, logger: Logger) async throws -> Set<Int> {
        var applied: Set<Int> = []
        let rows = try await connection.query("SELECT version FROM schema_migrations", logger: logger)
        for try await version in rows.decode(Int.self) {
            applied.insert(version)
        }
        return applied
    }

    private static func apply(_ migration: Migration, connection: PostgresConnection, logger: Logger) async throws {
        for statement in migration.statements {
            try await connection.query(PostgresQuery(unsafeSQL: statement), logger: logger)
        }
        try await connection.query(
            "INSERT INTO schema_migrations (version, name) VALUES (\(migration.version), \(migration.name))",
            logger: logger
        )
        logger.info(
            "applied migration",
            metadata: ["version": "\(migration.version)", "name": "\(migration.name)"]
        )
    }
}
