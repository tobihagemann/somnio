import Foundation
import Logging
import Synchronization

/// Captures log lines (message plus rendered metadata), filtered by level, so a boot pass's
/// `.info` summary or `.error` collision lines can be asserted in an integration test. Shared by
/// the suites that exercise the boot reconciliation passes (`NameSkeletonBackfill`,
/// `OrphanNPCDialogStatePrune`).
final class CapturingLogHandler: LogHandler, Sendable {
    private let captured = Mutex<[(Logger.Level, String)]>([])

    func lines(at level: Logger.Level) -> [String] {
        captured.withLock { entries in entries.filter { $0.0 == level }.map(\.1) }
    }

    var infoLines: [String] {
        lines(at: .info)
    }

    var errorLines: [String] {
        lines(at: .error)
    }

    var logLevel: Logger.Level {
        get { .trace }
        set { _ = newValue }
    }

    var metadata: Logger.Metadata {
        get { [:] }
        set { _ = newValue }
    }

    var metadataProvider: Logger.MetadataProvider? {
        get { nil }
        set { _ = newValue }
    }

    subscript(metadataKey key: String) -> Logger.Metadata.Value? {
        get { nil }
        set { _ = newValue }
    }

    func log(event: LogEvent) {
        let rendered = (event.metadata ?? [:]).map { "\($0.key)=\($0.value)" }.joined(separator: " ")
        captured.withLock { $0.append((event.level, "\(event.message) \(rendered)")) }
    }
}
