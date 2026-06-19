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
/// 4. Bracketed IPv6 literals (`ws://[::1]/...`) are rejected. Foundation strips the
///    brackets so `URL.host` reads back `::1` (passing the loopback gate), but the
///    WebSocket dialer's URI parser stops the host scan at the first `:` and dials the
///    literal `[` instead. The validator owns this policy rather than relying on the
///    dialer to fail closed.
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
        if let encodedHost = URLComponents(string: url)?.percentEncodedHost,
           encodedHost.contains("[") || encodedHost.contains("]") {
            throw SecureTransportValidationError.invalidURL
        }
        guard scheme == "ws" else { return }
        let host = parsed.host?.lowercased() ?? ""
        guard loopbackHosts.contains(host) else {
            throw SecureTransportValidationError.insecureRemoteURL
        }
    }

    /// Companion check a caller runs on the **same string** immediately before handing it,
    /// unmodified, to a WebSocket client whose URI parser differs from Foundation's. `validate`
    /// confirms the policy (scheme/userinfo/loopback) using Foundation's `URL.host`; this confirms
    /// the dialer's parser will see that same host. The raw host token a URI parser reads
    /// (`URLComponents.percentEncodedHost`) is compared byte-for-byte against `URL.host` with no
    /// normalization — equal for plain ASCII hosts, divergent for percent-encoded/IDN forms
    /// (`wss://☃.example` → `xn--n3h.example` vs `%E2%98%83.example`) and bracketed IPv6 literals
    /// (`ws://[::1]` → `::1` vs `[::1]`, which such a parser cannot dial anyway). A fragment is
    /// rejected outright: Foundation reads `ws://host#x` as host `host` + fragment `x`, but a URI
    /// parser with no fragment concept dials the literal `host#x`. Throws on any disagreement so
    /// the caller fails closed; on success the caller dials the original validated string,
    /// preserving query, port, and path exactly. Kept separate from `validate` because callers
    /// that dial a compile-time literal URL have no need for it.
    public static func validateHostAgreement(_ url: String) throws {
        guard
            let components = URLComponents(string: url),
            components.fragment == nil,
            let parsedHost = URL(string: url)?.host,
            let componentsHost = components.percentEncodedHost,
            parsedHost == componentsHost
        else {
            throw SecureTransportValidationError.invalidURL
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
