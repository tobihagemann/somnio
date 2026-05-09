import Foundation
import Logging
import Synchronization

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

    private static let bootstrapState = Mutex(false)

    /// Configures the logging system. Safe to call multiple times; only the first call takes effect.
    public static func bootstrap() {
        bootstrapState.withLock { done in
            guard !done else { return }
            done = true

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
