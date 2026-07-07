import Foundation
import Logging

/// Bootstraps the swift-log system for the player client, editor, and CLI.
///
/// On Apple platforms: `MultiplexLogHandler([OSLogHandler, FileLogHandler(somnio.log)])`.
/// On Linux: `MultiplexLogHandler([JSONLogHandler, FileLogHandler(somnio.log)])`.
///
/// The server uses `ServerLoggingConfiguration` (in `SomnioServerCore`) instead, which
/// composes a JSON stdout backend with two label-filtered file backends for gameplay and
/// admin logs.
public enum LoggingConfiguration {
    public static let clientLogFileName = "somnio.log"

    /// Resolves the dynamic file-log level from the persisted preference at every emit, so a
    /// runtime change (Options > Log level) takes effect without re-bootstrapping.
    static var fileLogLevel: Logger.Level {
        switch LogLevelPreference.current {
        case .standard: return .info
        case .debug: return .debug
        case .verbose: return .trace
        }
    }

    private static let latch = BootstrapLatch()

    /// Configures the logging system. Safe to call multiple times; only the first call takes effect.
    public static func bootstrap() {
        latch.runOnce {
            LoggingSystem.bootstrap { label in
                #if canImport(OSLog)
                    return MultiplexLogHandler([
                        OSLogHandler(label: label),
                        FileLogHandler(label: label, fileName: clientLogFileName, minimumLevel: { fileLogLevel })
                    ])
                #else
                    return MultiplexLogHandler([
                        JSONLogHandler(label: label),
                        FileLogHandler(label: label, fileName: clientLogFileName, minimumLevel: { fileLogLevel })
                    ])
                #endif
            }
        }
    }
}
