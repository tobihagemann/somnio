import Foundation

/// The player-facing file-log verbosity preference: the Options overlay writes it and the
/// file log handler reads it at every emit. One shared contract, so the picker's values
/// and the handler's interpretation can never desync. The raw values are the persisted
/// UserDefaults strings — `standard` keeps the historical `"default"` on disk.
public enum LogLevelPreference: String, CaseIterable, Sendable {
    case standard = "default"
    case debug
    case verbose

    public static let userDefaultsKey = "advancedLogLevel"

    /// The persisted preference, reading a missing or unrecognized value as `.standard`.
    public static var current: LogLevelPreference {
        let defaults = UserDefaults(suiteName: BuildEnvironment.userDefaultsSuiteName) ?? .standard
        return defaults.string(forKey: userDefaultsKey).flatMap(LogLevelPreference.init(rawValue:)) ?? .standard
    }

    public static func persist(_ preference: LogLevelPreference) {
        let defaults = UserDefaults(suiteName: BuildEnvironment.userDefaultsSuiteName) ?? .standard
        defaults.set(preference.rawValue, forKey: userDefaultsKey)
    }
}
