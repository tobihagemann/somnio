import Foundation
import Logging
import SomnioCore

/// Bootstraps the server's swift-log system with three handlers:
///
/// - `JSONLogHandler` to stdout (container-friendly). No filter — emits every record.
/// - A label-filtered `FileLogHandler` writing gameplay events to `gameplay-log.log`.
/// - A label-filtered `FileLogHandler` writing admin/console events to `admin-log.log`.
///
/// Server code uses `Logger(label: "de.tobiha.somnio.server.gameplay.<feature>")` for
/// gameplay events and `Logger(label: "de.tobiha.somnio.server.admin.<feature>")` for admin
/// events. Records that don't match either prefix go only to stdout (lifecycle/setup logs).
public enum ServerLoggingConfiguration {
    public static let gameplayLogFileName = "gameplay-log.log"
    public static let adminLogFileName = "admin-log.log"
    public static let gameplayLabelPrefix = "de.tobiha.somnio.server.gameplay"
    public static let adminLabelPrefix = "de.tobiha.somnio.server.admin"

    private static let latch = BootstrapLatch()

    public static func bootstrap() {
        latch.runOnce {
            LoggingSystem.bootstrap { label in
                let stdout = JSONLogHandler(label: label)
                let gameplay = LabelFilteringLogHandler(
                    label: label,
                    prefixes: [gameplayLabelPrefix],
                    inner: FileLogHandler(label: label, fileName: gameplayLogFileName)
                )
                let admin = LabelFilteringLogHandler(
                    label: label,
                    prefixes: [adminLabelPrefix],
                    inner: FileLogHandler(label: label, fileName: adminLogFileName)
                )
                return MultiplexLogHandler([stdout, gameplay, admin])
            }
        }
    }
}
