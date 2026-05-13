import Foundation

/// Single source of truth for the admin endpoint's debug-only defaults shared between
/// `SomnioCLICore.AdminConnectionResolver` and `SomnioServerCore.ServerConfiguration`.
/// Lives in `SomnioCore` because both modules import it; the CLI is forbidden from
/// importing `SomnioServerCore` (which is where the server-side config lives), so any
/// shared constant has to live below both.
///
/// These values are only consumed when neither the env var nor the explicit flag is set,
/// and in release builds the consumers reject a missing value rather than fall back to
/// these.
public enum AdminDebugDefaults {
    /// TCP port the gameplay server listens on in dev mode and the CLI connects to.
    public static let port: Int = 8080

    /// Bearer token the gameplay server accepts in dev mode and the CLI sends.
    public static let bearerToken: String = "dev-admin"

    /// Loopback URL the CLI uses to reach the dev server's `/admin` route.
    public static let websocketURL: String = "ws://127.0.0.1:\(port)/admin"
}
