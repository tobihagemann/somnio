import Foundation

/// One ordered batch of single SQL statements to apply atomically as a schema migration.
///
/// PostgresNIO's extended-query protocol forbids more than one statement per `Parse`
/// message, so each migration is modelled as a list of single statements that the runner
/// executes one-by-one inside a single transaction. `version` is the monotonic registry
/// position used to look up which migrations have been applied; `name` is human-readable
/// and stored in `schema_migrations` for operator inspection.
public struct Migration: Sendable {
    public let version: Int
    public let name: String
    public let statements: [String]

    public init(version: Int, name: String, statements: [String]) {
        self.version = version
        self.name = name
        self.statements = statements
    }
}
