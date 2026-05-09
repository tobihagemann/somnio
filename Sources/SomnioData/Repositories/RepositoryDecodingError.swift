import Foundation

/// Surfaces a repository row-mapping failure when raw column data cannot be lifted into a
/// project enum or value type. Distinct from `PostgresDecodingError` (which covers wire-format
/// faults) and from `PSQLError` (which covers transport faults).
public enum RepositoryDecodingError: Error, Sendable, Equatable {
    case invalidEnumRawValue(field: String, rawValue: Int)
    case invalidJSONBPayload(field: String, underlying: String)
}
