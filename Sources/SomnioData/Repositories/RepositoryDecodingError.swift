import Foundation

/// Surfaces a repository row-mapping failure when raw column data cannot be lifted into a
/// project enum or value type. Distinct from `PostgresDecodingError` (which covers wire-format
/// faults) and from `PSQLError` (which covers transport faults).
public enum RepositoryDecodingError: Error, Sendable, Equatable {
    case invalidEnumRawValue(field: String, rawValue: Int)
    case invalidJSONBPayload(field: String, underlying: String)
}

/// Repository-level domain errors surfaced when an operation can complete at the SQL layer
/// but violates the repository's contract (e.g., updating a row that doesn't exist).
public enum RepositoryError: Error, Sendable, Equatable {
    case noSuchCharacter(id: UUID)
}
