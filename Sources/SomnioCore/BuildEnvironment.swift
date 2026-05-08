import Foundation

public enum BuildEnvironment {
    /// Pure helper that resolves the Application Support folder name from a profile + build flag.
    /// Internal so tests can exercise both DEBUG and release branches without exposing a stable
    /// public API; tests reach it via `@testable import SomnioCore`.
    static func computeAppSupportDirectoryName(profile: String?, isDebug: Bool) -> String {
        guard isDebug else { return "Somnio" }
        if let profile { return "Somnio-Dev-\(profile)" }
        return "Somnio-Dev"
    }

    /// Pure helper that resolves the UserDefaults suite name from a profile + build flag.
    /// Returns `nil` for release builds (so callers fall back to `.standard`).
    static func computeUserDefaultsSuiteName(profile: String?, isDebug: Bool) -> String? {
        guard isDebug else { return nil }
        if let profile { return "de.tobiha.somnio.dev.\(profile)" }
        return "de.tobiha.somnio.dev"
    }

    /// Pure helper that resolves the Postgres database name from a profile + build flag.
    /// Release builds always use `somnio`; dev builds use `somnio_dev` (or `somnio_dev_<profile>`).
    static func computeDatabaseName(profile: String?, isDebug: Bool) -> String {
        guard isDebug else { return "somnio" }
        if let profile { return "somnio_dev_\(profile)" }
        return "somnio_dev"
    }

    #if DEBUG
        private static let profileName = ProcessInfo.processInfo.environment["SOMNIO_PROFILE"]
        public static let appSupportDirectoryName = computeAppSupportDirectoryName(profile: profileName, isDebug: true)
        public static let useKeychain = ProcessInfo.processInfo.environment["SOMNIO_USE_KEYCHAIN"] == "1"
        public static let userDefaultsSuiteName: String? = computeUserDefaultsSuiteName(profile: profileName, isDebug: true)
        public static let databaseName = computeDatabaseName(profile: profileName, isDebug: true)
    #else
        public static let appSupportDirectoryName = computeAppSupportDirectoryName(profile: nil, isDebug: false)
        public static let useKeychain = true
        public static let userDefaultsSuiteName: String? = computeUserDefaultsSuiteName(profile: nil, isDebug: false)
        public static let databaseName = computeDatabaseName(profile: nil, isDebug: false)
    #endif

    public static var appSupportDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent(appSupportDirectoryName, isDirectory: true)
    }
}
