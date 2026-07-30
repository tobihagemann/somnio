import Crypto
import Foundation
import Logging
import PostgresNIO

/// One issued session: the raw bearer token (returned to the client exactly once) plus its
/// lifetime. The raw value never leaves this struct — the repository persists only a digest.
public struct IssuedSession: Sendable, Equatable {
    public var token: String
    public var expiresAt: Date

    public init(token: String, expiresAt: Date) {
        self.token = token
        self.expiresAt = expiresAt
    }
}

/// A redeemed session resolved back to its owner.
public struct ResolvedSession: Sendable, Equatable {
    public var accountId: UUID
    public var expiresAt: Date

    public init(accountId: UUID, expiresAt: Date) {
        self.accountId = accountId
        self.expiresAt = expiresAt
    }
}

/// Session policy that belongs to the feature rather than to any one storage backend.
///
/// Separate from `PostgresSessionRepository` because handlers hold `any SessionRepository`: a
/// lifetime read off the concrete actor would reach through the abstraction, and a second
/// repository implementation would silently inherit Postgres' number.
public enum SessionPolicy {
    /// 30 days. Long enough that a casual player is not re-prompted between visits, short enough
    /// that an abandoned token on a shared machine ages out on its own.
    public static let defaultLifetime: TimeInterval = 30 * 24 * 60 * 60

    /// Live sessions retained per account before the oldest is evicted.
    ///
    /// Generous for the legitimate case — a desktop, a laptop, and a phone browser is three — while
    /// still turning "unbounded until expiry" into a constant. The bound has to live somewhere the
    /// repository enforces rather than in a sweep, because the sweep only sees *expired* rows and a
    /// live row is never removed by the connection path.
    public static let maxPerAccount = 10
}

public protocol SessionRepository: Sendable {
    /// Mints a token for `accountId`, persists its digest, and returns the raw value. The caller
    /// must send it onward immediately: it is unrecoverable afterwards.
    func issue(accountId: UUID, lifetime: TimeInterval) async throws -> IssuedSession
    /// Resolves a raw token to its owner, or `nil` when it is unknown, expired, or revoked —
    /// three cases the caller deliberately cannot tell apart.
    func redeem(token: String) async throws -> ResolvedSession?
    /// Deletes the row for `token`, but only when it belongs to `accountId`. Returns whether a row
    /// was actually removed, so logout can report a truthful acknowledgement rather than an
    /// optimistic one.
    ///
    /// The account is part of the match, not a post-hoc check, so a caller holding someone else's
    /// token cannot delete their session — and a `false` result cannot be read as "that token does
    /// not exist" for a token the caller does not own.
    @discardableResult
    func revoke(token: String, accountId: UUID) async throws -> Bool
    /// Bulk cleanup of expired rows. Expiry is already enforced on the read path; this only
    /// keeps the table from growing without bound.
    @discardableResult
    func deleteExpired(asOf now: Date) async throws -> Int
}

/// Sessions turned off: issuing throws, redemption never resolves, revocation reports nothing
/// removed.
///
/// Deliberately **fail-closed** rather than fail-open. This is the default a connection gets
/// when no repository was wired, and the failure mode that matters is a deployment that quietly
/// hands out tokens nothing can revoke. With this stand-in the worst case is that resumption
/// does not work and the client falls back to the password form — the behavior it already has
/// to implement for a rolled-back server.
public struct DisabledSessionRepository: SessionRepository {
    public init() {}

    public func issue(accountId _: UUID, lifetime _: TimeInterval) async throws -> IssuedSession {
        throw SessionRepositoryError.sessionsDisabled
    }

    public func redeem(token _: String) async throws -> ResolvedSession? {
        nil
    }

    @discardableResult
    public func revoke(token _: String, accountId _: UUID) async throws -> Bool {
        false
    }

    @discardableResult
    public func deleteExpired(asOf _: Date) async throws -> Int {
        0
    }
}

public enum SessionRepositoryError: Error, Equatable, Sendable {
    case sessionsDisabled
}

public actor PostgresSessionRepository: SessionRepository {
    /// 256 bits of CSPRNG output. Well past any guessing budget, which is precisely what makes
    /// the unsalted digest safe: there is no low-entropy structure for an offline attacker to
    /// grind against.
    private static let tokenByteCount = 32

    private let client: PostgresClient
    private let logger: Logger

    public init(client: PostgresClient, logger: Logger) {
        self.client = client
        self.logger = logger
    }

    /// No default argument, matching every sibling repository in this module: a default is
    /// invisible through `any SessionRepository`, so it would apply to tests and never to
    /// production, leaving the two exercising different call shapes.
    ///
    /// The insert and the cap eviction share one transaction, because a partial success here is
    /// unrecoverable rather than merely untidy. `LoginHandler.issueToken` logs and swallows a throw
    /// from this method — the player is already authenticated, so losing issuance must not cost them
    /// the session — so if the insert committed and the eviction then failed, the digest would be
    /// stored while the raw token was never sent, and an unsalted SHA-256 of 256 CSPRNG bits cannot
    /// be recovered from it. Worse, the orphan is the *newest* row, and `evictOldestBeyondCap` keeps
    /// the newest `maxPerAccount`, so it is the last thing evicted: it holds a cap slot for the full
    /// lifetime and pushes a token the player is actually using out one login early.
    ///
    /// The rollback itself is argued rather than observed: no tier drives a failure between the two
    /// statements, because `PostgresClient` offers no seam to force one and adding a production hook
    /// to serve a single test is out of proportion here. Replacing this with two independent queries
    /// would pass the whole suite — so treat the transaction as load-bearing on inspection, and do
    /// not unwrap it on the strength of a green run.
    public func issue(accountId: UUID, lifetime: TimeInterval) async throws -> IssuedSession {
        let token = Self.makeToken()
        let digest = Self.digest(of: token)
        let expiresAt = Date().addingTimeInterval(lifetime)
        try await client.withTransaction(logger: logger) { connection in
            try await connection.query(
                """
                INSERT INTO sessions (token_digest, account_id, expires_at)
                VALUES (\(digest), \(accountId), \(expiresAt))
                """,
                logger: logger
            )
            try await evictOldestBeyondCap(accountId: accountId, connection: connection)
        }
        return IssuedSession(token: token, expiresAt: expiresAt)
    }

    /// Drops an account's oldest sessions once it holds more than `SessionPolicy.maxPerAccount`.
    ///
    /// `deleteExpired` alone does not bound this table. Nothing on the connection path removes a
    /// *live* row, deliberately — refresh, network loss, and a normal close must all preserve the
    /// token for resumption — so expiry-only cleanup bounds the table at (issuance rate x 30 days),
    /// which is a function of how often anyone logs in rather than a constant. Registration is open,
    /// so a scripted login loop accumulates month-lived rows until the volume fills and every write
    /// behind `/health` and the character checkpoints starts failing.
    ///
    /// Ordering is by `expires_at` rather than by `created_at`, which the table does carry: only
    /// `expires_at` is indexed (`sessions_expires_at_idx`), and with a fixed lifetime the two order
    /// identically, so the indexed column answers the same question without a sort. Evicting the
    /// oldest is what makes the cap a sliding window: signing in on a new device pushes out the
    /// least recently issued session rather than being refused. Were the lifetime ever made
    /// variable, these would diverge and `created_at` would become the correct column.
    ///
    /// Takes the connection rather than reaching for `client`, so it runs inside `issue`'s
    /// transaction instead of opening a second, independently committed one.
    private func evictOldestBeyondCap(accountId: UUID, connection: PostgresConnection) async throws {
        try await connection.query(
            """
            DELETE FROM sessions
            WHERE account_id = \(accountId)
              AND token_digest NOT IN (
                SELECT token_digest FROM sessions
                WHERE account_id = \(accountId)
                ORDER BY expires_at DESC
                LIMIT \(SessionPolicy.maxPerAccount)
              )
            """,
            logger: logger
        )
    }

    /// Expiry is filtered in SQL rather than compared after the fetch, so a row that aged out
    /// between the write and this read can never resolve.
    ///
    /// The comparison binds a Swift `Date` rather than using `NOW()`, matching how this module
    /// writes and compares timestamps everywhere else (`PostgresAccountRepository.create` passes an
    /// explicit `createdAt` despite the column's `DEFAULT NOW()`; `PostgresCharacterRepository`
    /// compares against a bound `Date`). One clock authority means `issue`, `redeem`, and
    /// `deleteExpired` cannot disagree about whether the same row is expired under clock skew.
    public func redeem(token: String) async throws -> ResolvedSession? {
        let rows = try await client.query(
            """
            SELECT account_id, expires_at
            FROM sessions
            WHERE token_digest = \(Self.digest(of: token)) AND expires_at > \(Date())
            """,
            logger: logger
        )
        for try await row in rows {
            return try row.decodeSession()
        }
        return nil
    }

    @discardableResult
    public func revoke(token: String, accountId: UUID) async throws -> Bool {
        let rows = try await client.query(
            """
            DELETE FROM sessions
            WHERE token_digest = \(Self.digest(of: token)) AND account_id = \(accountId)
            RETURNING token_digest
            """,
            logger: logger
        )
        for try await _ in rows {
            return true
        }
        return false
    }

    @discardableResult
    public func deleteExpired(asOf now: Date) async throws -> Int {
        let rows = try await client.query(
            "DELETE FROM sessions WHERE expires_at <= \(now) RETURNING token_digest",
            logger: logger
        )
        var deleted = 0
        for try await _ in rows {
            deleted += 1
        }
        return deleted
    }

    /// URL-safe base64 without padding, so the token survives storage, headers, and query
    /// strings unescaped.
    ///
    /// The bytes come from `SymmetricKey`, whose generation is specified to use a cryptographic
    /// random source. `SystemRandomNumberGenerator` would also be suitable, but routing through
    /// the crypto library states the requirement in the type rather than in a comment.
    static func makeToken() -> String {
        let bytes = SymmetricKey(size: .init(bitCount: tokenByteCount * 8)).withUnsafeBytes { Data($0) }
        return bytes.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Hex-encoded SHA-256. `internal` so the repository tests can assert the raw token is never
    /// what lands in the column.
    static func digest(of token: String) -> String {
        SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

private extension PostgresRow {
    func decodeSession() throws -> ResolvedSession {
        let (accountId, expiresAt) = try decode((UUID, Date).self)
        return ResolvedSession(accountId: accountId, expiresAt: expiresAt)
    }
}
