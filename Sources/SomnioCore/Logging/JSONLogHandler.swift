import Foundation
import Logging
import Synchronization

/// A swift-log `LogHandler` that emits one JSON object per line to stdout. Used by the
/// server for container-friendly structured logging. Pure-Swift; no `os` dependency, so it
/// compiles on Linux. Each emitted object has the shape (keys sorted lexicographically):
///
///     {"label":"...","level":"info","message":"...","ts":"..."}
///
/// `error` and `metadata` appear only when present (non-nil error, non-empty metadata).
public struct JSONLogHandler: LogHandler {
    private let label: String

    public var logLevel: Logger.Level = .trace
    public var metadata: Logger.Metadata = [:]
    public var metadataProvider: Logger.MetadataProvider?

    public init(label: String) {
        self.label = label
    }

    public func log(event: LogEvent) {
        guard let line = jsonLine(for: event) else { return }

        // `FileHandle.write` is not atomic for arbitrary-sized payloads — concurrent emitters
        // would let JSON objects interleave on stdout, breaking the "one object per line"
        // contract. Serialize across all `JSONLogHandler` instances via a process-wide lock.
        Self.stdoutLock.withLock { _ in
            try? FileHandle.standardOutput.write(contentsOf: Data(line.utf8))
        }
    }

    /// Internal rather than private so tests can assert the emission shape without capturing stdout.
    func jsonLine(for event: LogEvent) -> String? {
        let merged = LogMetadata.merged(
            handler: metadata,
            provider: metadataProvider?.get(),
            event: event.metadata
        )
        let record = Record(
            ts: Date.now.formatted(Self.timestampStyle),
            level: event.level.rawValue,
            label: label,
            message: event.message.description,
            error: event.error.map { String(describing: $0) },
            metadata: merged.isEmpty ? nil : LogMetadata.flatStrings(merged)
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(record) else { return nil }
        return String(decoding: data, as: UTF8.self) + "\n"
    }

    public subscript(metadataKey key: String) -> Logger.Metadata.Value? {
        get { metadata[key] }
        set { metadata[key] = newValue }
    }

    /// Flat string-valued envelope so nested `Logger.MetadataValue` dictionaries/arrays render
    /// as their textual description (matching the file/OSLog handlers) rather than as nested
    /// JSON, keeping every emitted line a single flat object.
    private struct Record: Encodable {
        // periphery:ignore
        let ts: String
        // periphery:ignore
        let level: String
        // periphery:ignore
        let label: String
        // periphery:ignore
        let message: String
        // periphery:ignore
        let error: String?
        // periphery:ignore
        let metadata: [String: String]?
    }

    private static let timestampStyle = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let stdoutLock = Mutex<Void>(())
}
