import Foundation
import Logging
import Synchronization

/// A swift-log `LogHandler` that writes log entries to a rotating file.
///
/// Uses a shared `FileLogWriter` actor for thread-safe file I/O. Rotation triggers when the
/// current log file exceeds `maxFileSize`, keeping at most `maxArchivedFiles` old files.
///
/// `logLevel` is kept at `.trace` so that `MultiplexLogHandler` passes all messages through.
/// Actual filtering is done dynamically via `minimumLevelProvider`, which reads from
/// UserDefaults to support runtime debug-mode toggling without re-bootstrapping the logging
/// system.
public struct FileLogHandler: LogHandler {
    private let label: String
    private let writer: FileLogWriter
    private let minimumLevelProvider: @Sendable () -> Logger.Level

    public var logLevel: Logger.Level = .trace
    public var metadata: Logger.Metadata = [:]
    public var metadataProvider: Logger.MetadataProvider?

    public init(
        label: String,
        fileName: String,
        directory: URL = LoggingPaths.logsDirectory,
        minimumLevel: @escaping @Sendable () -> Logger.Level = { .info }
    ) {
        self.label = label
        self.writer = FileLogWriter.shared(directory: directory, fileName: fileName)
        self.minimumLevelProvider = minimumLevel
    }

    public func log(event: LogEvent) {
        guard event.level >= minimumLevelProvider() else { return }

        let timestamp = Date.now.formatted(Self.timestampStyle)
        let levelTag = event.level.rawValue.uppercased()
        let merged = LogMetadata.merged(
            handler: metadata,
            provider: metadataProvider?.get(),
            event: event.metadata
        )
        let suffix = LogMetadata.flatTextSuffix(merged: merged, error: event.error)
        let logLine = "[\(timestamp)] [\(levelTag)] [\(label)] \(event.message)\(suffix)\n"

        // Write inline so log lines stay in the order callers emitted them. The writer's
        // internal lock makes concurrent emitters serialize; offloading via `Task` would
        // hand them to the cooperative pool and re-order them at the actor's mailbox.
        writer.write(logLine)
    }

    private static let timestampStyle = Date.ISO8601FormatStyle(includingFractionalSeconds: true)

    public subscript(metadataKey key: String) -> Logger.Metadata.Value? {
        get { metadata[key] }
        set { metadata[key] = newValue }
    }
}

// MARK: - Logging Paths

/// Centralized path resolution for log files. Lives outside `LoggingConfiguration` so server
/// bootstrap (which composes its own handlers) can reuse the same directory layout.
public enum LoggingPaths {
    public static var logsDirectory: URL {
        BuildEnvironment.appSupportDirectory.appendingPathComponent("Logs", isDirectory: true)
    }
}

// MARK: - File Log Writer

/// Serialized file writer with size-based rotation. The mutable `FileHandle` is wrapped in a
/// `Synchronization.Mutex` so the writer is `Sendable` without resorting to `@unchecked`, while
/// `LogHandler.log(event:)` can still call `write(_:)` synchronously and preserve emission order.
public final class FileLogWriter: Sendable {
    private let directory: URL
    private let fileName: String
    private let maxFileSize: UInt64
    private let maxArchivedFiles: Int
    private let handleState: Mutex<FileHandle?>

    public init(
        directory: URL,
        fileName: String,
        maxFileSize: UInt64 = 5 * 1024 * 1024,
        maxArchivedFiles: Int = 5
    ) {
        self.directory = directory
        self.fileName = fileName
        self.maxFileSize = maxFileSize
        self.maxArchivedFiles = maxArchivedFiles
        self.handleState = Mutex<FileHandle?>(nil)
    }

    /// Returns the shared writer for the given directory + fileName, creating one if needed.
    /// Multiple `FileLogHandler` instances writing to the same file must share the same writer
    /// so the underlying `FileHandle` is serialized.
    public static func shared(directory: URL, fileName: String) -> FileLogWriter {
        let key = directory.appendingPathComponent(fileName).path
        return cacheStorage.withLock { storage in
            if let existing = storage[key] {
                return existing
            }
            let writer = FileLogWriter(directory: directory, fileName: fileName)
            storage[key] = writer
            return writer
        }
    }

    private static let cacheStorage = Mutex<[String: FileLogWriter]>([:])

    /// The path to the current log file.
    public var currentLogFile: URL {
        directory.appendingPathComponent(fileName)
    }

    /// All log files (current + archived), sorted by recency.
    public var allLogFiles: [URL] {
        var files: [URL] = []
        let current = currentLogFile
        if FileManager.default.fileExists(atPath: current.path) {
            files.append(current)
        }
        for i in 1 ... maxArchivedFiles {
            let archived = archivedFile(index: i)
            if FileManager.default.fileExists(atPath: archived.path) {
                files.append(archived)
            }
        }
        return files
    }

    public func write(_ line: String) {
        guard let data = line.data(using: .utf8) else { return }
        handleState.withLock { handle in
            guard let active = ensureFileHandle(&handle) else { return }
            try? active.write(contentsOf: data)
            rotateIfNeeded(&handle)
        }
    }

    // MARK: - Rotation

    private func rotateIfNeeded(_ handle: inout FileHandle?) {
        guard let active = handle else { return }
        guard let size = try? active.offset() else { return }
        guard size >= maxFileSize else { return }

        try? active.close()
        handle = nil

        let fm = FileManager.default
        let oldest = archivedFile(index: maxArchivedFiles)
        try? fm.removeItem(at: oldest)

        for i in stride(from: maxArchivedFiles - 1, through: 1, by: -1) {
            let src = archivedFile(index: i)
            let dst = archivedFile(index: i + 1)
            if fm.fileExists(atPath: src.path) {
                try? fm.moveItem(at: src, to: dst)
            }
        }

        try? fm.moveItem(at: currentLogFile, to: archivedFile(index: 1))
    }

    func archivedFile(index: Int) -> URL {
        let base = (fileName as NSString).deletingPathExtension
        let ext = (fileName as NSString).pathExtension
        return directory.appendingPathComponent("\(base).\(index).\(ext)")
    }

    private func ensureFileHandle(_ handle: inout FileHandle?) -> FileHandle? {
        if let existing = handle {
            return existing
        }

        let fm = FileManager.default
        let file = currentLogFile

        if !fm.fileExists(atPath: directory.path) {
            try? fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }

        if !fm.fileExists(atPath: file.path) {
            fm.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }

        guard let opened = FileHandle(forWritingAtPath: file.path) else { return nil }
        try? opened.seekToEnd()
        handle = opened
        return opened
    }
}
