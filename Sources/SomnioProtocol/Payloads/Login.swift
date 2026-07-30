import Foundation

public struct LoginMessage: Codable, Sendable, Equatable {
    public var nickname: String
    public var password: String
    /// Ask the server to issue a resumable session token alongside a successful login.
    ///
    /// **Optional on purpose, and it must stay that way.** The synthesized `Codable` emits
    /// `decodeIfPresent` for an Optional, so a client built before this field still decodes on a
    /// token-aware server, and `encodeIfPresent` keeps the key off the wire when it is `nil` so
    /// nothing changes for clients that never opt in. That is what lets the feature ship without
    /// bumping `helloVersion` — the gate is strict equality, so a bump would *reject* clients
    /// that would otherwise work fine. Making this non-Optional reintroduces the bump.
    public var requestSessionToken: Bool?

    public init(nickname: String, password: String, requestSessionToken: Bool? = nil) {
        self.nickname = nickname
        self.password = password
        self.requestSessionToken = requestSessionToken
    }
}
