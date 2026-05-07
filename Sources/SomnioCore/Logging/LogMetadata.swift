import Logging

// Shared swift-log metadata helpers used by every project `LogHandler`. Lives here rather
// than on any one handler so the dependency direction reflects what the logic actually is:
// generic enrichment that has nothing to do with file vs stdout vs OSLog output.

enum LogMetadata {
    /// Merge handler-level, provider, and event-level metadata in swift-log's canonical
    /// resolution order: handler-level → provider → event-level (last write wins).
    static func merged(
        handler: Logger.Metadata,
        provider: Logger.Metadata?,
        event: Logger.Metadata?
    ) -> Logger.Metadata {
        var merged = handler
        if let provider {
            merged.merge(provider) { _, new in new }
        }
        if let event {
            merged.merge(event) { _, new in new }
        }
        return merged
    }

    /// Render merged metadata + an optional error as a flat-text suffix for the file and
    /// OSLog handlers. JSON output uses its own envelope. Empty metadata + nil error yields
    /// the empty string so the caller can append it unconditionally.
    static func flatTextSuffix(merged: Logger.Metadata, error: (any Error)?) -> String {
        let metadataPart = merged.isEmpty
            ? ""
            : " " + merged.sorted(by: { $0.key < $1.key })
            .map { "\($0.key)=\($0.value)" }
            .joined(separator: " ")
        let errorPart = error.map { " error=\(String(describing: $0))" } ?? ""
        return metadataPart + errorPart
    }
}
