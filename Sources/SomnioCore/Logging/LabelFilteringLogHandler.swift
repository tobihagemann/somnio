import Logging

/// A `LogHandler` wrapper that delegates to an inner handler only when the logger's label
/// starts with one of a configured set of prefixes. Used by the server bootstrap to route
/// per-feature loggers to gameplay / admin file backends without every record being
/// broadcast to every backend.
public struct LabelFilteringLogHandler: LogHandler {
    private let label: String
    private let prefixes: [String]
    private var inner: any LogHandler

    public init(label: String, prefixes: [String], inner: any LogHandler) {
        self.label = label
        self.prefixes = prefixes
        self.inner = inner
    }

    public var logLevel: Logger.Level {
        get { inner.logLevel }
        set { inner.logLevel = newValue }
    }

    public var metadata: Logger.Metadata {
        get { inner.metadata }
        set { inner.metadata = newValue }
    }

    public var metadataProvider: Logger.MetadataProvider? {
        get { inner.metadataProvider }
        set { inner.metadataProvider = newValue }
    }

    public func log(event: LogEvent) {
        guard prefixes.contains(where: { label.hasPrefix($0) }) else { return }
        inner.log(event: event)
    }

    public subscript(metadataKey key: String) -> Logger.Metadata.Value? {
        get { inner[metadataKey: key] }
        set { inner[metadataKey: key] = newValue }
    }
}
