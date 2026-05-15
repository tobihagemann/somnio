import Foundation

/// Errors raised by `SecureTransportValidator.validate` when a candidate WebSocket URL
/// would carry credentials over plaintext or otherwise violates the gate. Mapped to
/// transport-specific error types at each call site.
public enum SecureTransportValidationError: Error, Equatable, Sendable {
    case invalidURL
    case unsupportedScheme
    case insecureRemoteURL
    case userinfoNotAllowed
}

/// Single source of truth for the WebSocket URL gate the player client and admin CLI
/// both apply before opening a connection. Rules:
///
/// 1. Lowercase `ws`/`wss` scheme only — `WebSocketClient` compares scheme
///    case-sensitively when deciding whether to enable TLS.
/// 2. `ws://` is allowed only against the loopback set; remote hosts must use `wss://`.
/// 3. URLs carrying userinfo (`user`/`password`) are rejected outright. Foundation's
///    `URL.host` parser disagrees with `WebSocketClient`'s parser on
///    `ws://attacker.example@localhost/...`: Foundation reports `host == "localhost"`
///    (passing the loopback gate), but the WebSocket layer dials `attacker.example`,
///    leaking credentials over plaintext to a third-party host. Refusing userinfo
///    closes that gap independent of which parser disagreement comes next.
public enum SecureTransportValidator {
    /// Exact hostnames whose loopback semantics make plaintext `ws://` acceptable.
    public static let loopbackHosts: Set<String> = ["localhost", "127.0.0.1", "::1"]

    /// Throws `SecureTransportValidationError` if `url` would carry credentials over
    /// plaintext, uses a non-lowercase scheme, or carries userinfo.
    public static func validate(_ url: String) throws {
        guard let parsed = URL(string: url) else {
            throw SecureTransportValidationError.invalidURL
        }
        if parsed.user != nil || parsed.password != nil {
            throw SecureTransportValidationError.userinfoNotAllowed
        }
        let scheme = parsed.scheme ?? ""
        guard scheme == "ws" || scheme == "wss" else {
            throw SecureTransportValidationError.unsupportedScheme
        }
        guard scheme == "ws" else { return }
        let host = parsed.host?.lowercased() ?? ""
        guard loopbackHosts.contains(host) else {
            throw SecureTransportValidationError.insecureRemoteURL
        }
    }

    /// Stricter variant for the debug-only env-var override path: also requires the
    /// host to be loopback regardless of scheme. Closes the env-var-injection
    /// vector where a tampered shell profile redirects the client to a
    /// credential-harvesting `wss://` endpoint.
    public static func validateLoopbackOnly(_ url: String) throws {
        try validate(url)
        guard let parsed = URL(string: url) else {
            throw SecureTransportValidationError.invalidURL
        }
        let host = parsed.host?.lowercased() ?? ""
        guard loopbackHosts.contains(host) else {
            throw SecureTransportValidationError.insecureRemoteURL
        }
    }
}
