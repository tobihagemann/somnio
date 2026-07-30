import Foundation

/// Redeem a stored session token in place of a password login. Accepted **pre-login only**:
/// it is an alternative to `LoginMessage`, not something an attached connection can replay.
///
/// The outcome reuses `LoginResultMessage` rather than introducing a redeem-specific response.
/// That keeps the new-tag count down and, more importantly, makes an expired, unknown, and
/// revoked token indistinguishable to the client — all three answer `.badCredentials`, so a
/// probing client learns nothing about which tokens ever existed.
public struct RedeemSessionMessage: Codable, Sendable, Equatable {
    public var token: String

    public init(token: String) {
        self.token = token
    }
}

/// Revoke the token presented on this connection. Accepted **post-attach only**.
///
/// Revocation deliberately does not ride ordinary disconnect cleanup: refresh, network loss,
/// and a normal socket close must all *preserve* the token, since resumption across exactly
/// those events is the point of the feature. Only an explicit logout destroys it. Scope is the
/// presented token alone — "log out everywhere" is a different feature.
public struct RevokeSessionMessage: Codable, Sendable, Equatable {
    public var token: String

    public init(token: String) {
        self.token = token
    }
}

/// Sent only in response to a `Login` that asked for one. A successful `RedeemSession` resolves the
/// presented token and mints no replacement — redemption deliberately does not rotate, because
/// rotating before `WorldRouter.register` succeeds would invalidate the credential on the first
/// `alreadyLoggedIn` answer and break the bounded resume retry. So no frame of this kind follows a
/// resume, and a client must not wait for one. The raw token is returned exactly once; the server
/// keeps only a digest.
public struct SessionTokenMessage: Codable, Sendable, Equatable {
    public var token: String
    /// Seconds until expiry. `Int32` because the 30-day lifetime is 2,592,000 seconds, well
    /// past `Int16`. Sending a duration rather than an absolute instant means the client never
    /// has to trust its own clock offset.
    public var expiresInSeconds: Int32

    public init(token: String, expiresInSeconds: Int32) {
        self.token = token
        self.expiresInSeconds = expiresInSeconds
    }
}

/// Acknowledgement that the presented token's row is gone. Request-gated like every other
/// session frame: the server sends it only in response to a `RevokeSessionMessage`.
public struct SessionRevokedMessage: Codable, Sendable, Equatable {
    public var revoked: Bool

    public init(revoked: Bool) {
        self.revoked = revoked
    }
}
