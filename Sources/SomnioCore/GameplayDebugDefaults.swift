import Foundation

/// Single source of truth for the gameplay endpoint's debug-only defaults consumed by
/// the player client's URL resolver. Mirrors `AdminDebugDefaults` in shape; release
/// builds reject a missing value at compile time rather than fall back to these.
public enum GameplayDebugDefaults {
    /// TCP port the gameplay server listens on in dev mode and the client connects to.
    public static let port: Int = 8080

    /// Loopback URL the client uses to reach the dev server's `/ws` route.
    public static let websocketURL: String = "ws://127.0.0.1:\(port)/ws"
}
