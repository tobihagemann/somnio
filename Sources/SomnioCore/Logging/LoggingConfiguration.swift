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

    private static let logLevelKey = "advancedLogLevel"

    /// Resolves the dynamic file-log level from UserDefaults at every emit, so a runtime change
    /// (Preferences > Advanced > Log Level) takes effect without re-bootstrapping.
    static var fileLogLevel: Logger.Level {
        let defaults = UserDefaults(suiteName: BuildEnvironment.userDefaultsSuiteName) ?? .standard
        switch defaults.string(forKey: logLevelKey) {
        case "debug": return .debug
        case "verbose": return .trace
        default: return .info
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
