import Foundation
import Logging
import PostgresNIO
import SomnioData
import Testing

/// Postgres-backed coverage for the session repository: issue, lookup, expiry, revocation, and
/// the at-rest guarantee. The pure token/digest behaviour lives in `SomnioDataTests`.
@Suite(.requiresContainerRuntime)
struct SessionRepositoryTests {
    private func makeAccount(client: PostgresClient, logger: Logger, name: String) async throws -> UUID {
        let id = UUID()
        try await client.query(
            """
            INSERT INTO accounts (id, name, password_hash, email)
            VALUES (\(id), \(name), 'hash', \(name + "@example.com"))
            """,
            logger: logger
        )
        return id
    }

    @Test func `an issued token redeems back to its account`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.sessions.redeem")
            let repository = PostgresSessionRepository(client: client, logger: logger)
            let accountId = try await makeAccount(client: client, logger: logger, name: "redeem-user")

            let issued = try await repository.issue(accountId: accountId, lifetime: 3600)
            let resolved = try await repository.redeem(token: issued.token)

            #expect(resolved?.accountId == accountId)
        }
    }

    /// The row must never contain a replayable credential: a database read has to be useless to
    /// an attacker who cannot also mint the digest's preimage.
    @Test func `the raw token is never stored`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.sessions.at-rest")
            let repository = PostgresSessionRepository(client: client, logger: logger)
            let accountId = try await makeAccount(client: client, logger: logger, name: "at-rest-user")

            let issued = try await repository.issue(accountId: accountId, lifetime: 3600)

            let rows = try await client.query(
                "SELECT token_digest FROM sessions WHERE account_id = \(accountId)",
                logger: logger
            )
            var digests: [String] = []
            for try await digest in rows.decode(String.self) {
                digests.append(digest)
            }
            #expect(digests.count == 1)
            #expect(digests[0] != issued.token)
            #expect(digests[0].count == 64)
        }
    }

    @Test func `an unknown token resolves to nothing`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.sessions.unknown")
            let repository = PostgresSessionRepository(client: client, logger: logger)
            let resolved = try await repository.redeem(token: "never-issued")
            #expect(resolved == nil)
        }
    }

    /// Expiry is filtered in SQL rather than compared after the fetch, so a row that ages out
    /// between the write and the read can never resolve.
    @Test func `an expired token resolves to nothing`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.sessions.expired")
            let repository = PostgresSessionRepository(client: client, logger: logger)
            let accountId = try await makeAccount(client: client, logger: logger, name: "expired-user")

            let issued = try await repository.issue(accountId: accountId, lifetime: -60)

            let resolved = try await repository.redeem(token: issued.token)
            #expect(resolved == nil)
        }
    }

    /// The assertion that matters for logout: the token must be unusable *afterwards*. Asserting
    /// only that a revoke message was sent proves nothing about the row.
    @Test func `a revoked token is unusable afterwards`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.sessions.revoke")
            let repository = PostgresSessionRepository(client: client, logger: logger)
            let accountId = try await makeAccount(client: client, logger: logger, name: "revoke-user")
            let issued = try await repository.issue(accountId: accountId, lifetime: 3600)
            let beforeRevoke = try await repository.redeem(token: issued.token)
            #expect(beforeRevoke != nil)

            let removed = try await repository.revoke(token: issued.token, accountId: accountId)
            let afterRevoke = try await repository.redeem(token: issued.token)

            #expect(removed)
            #expect(afterRevoke == nil)
        }
    }

    @Test func `revoking an unknown token reports nothing removed`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.sessions.revoke-unknown")
            let repository = PostgresSessionRepository(client: client, logger: logger)
            let removed = try await repository.revoke(token: "never-issued", accountId: UUID())
            #expect(removed == false)
        }
    }

    /// Ownership is part of the match, so a token belonging to another account survives — and the
    /// `false` result cannot be read as "that token does not exist".
    @Test func `revoking another account's token removes nothing`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.sessions.revoke-foreign")
            let repository = PostgresSessionRepository(client: client, logger: logger)
            let owner = try await makeAccount(client: client, logger: logger, name: "revoke-owner")
            let other = try await makeAccount(client: client, logger: logger, name: "revoke-other")
            let issued = try await repository.issue(accountId: owner, lifetime: 3600)

            let removed = try await repository.revoke(token: issued.token, accountId: other)
            let stillValid = try await repository.redeem(token: issued.token)

            #expect(removed == false)
            #expect(stillValid != nil)
        }
    }

    /// Revocation is scoped to the presented token alone — "log out everywhere" is a different
    /// feature, and a revoke that silently killed sibling sessions would be a surprising one.
    @Test func `revocation leaves the account's other sessions intact`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.sessions.scope")
            let repository = PostgresSessionRepository(client: client, logger: logger)
            let accountId = try await makeAccount(client: client, logger: logger, name: "scope-user")
            let first = try await repository.issue(accountId: accountId, lifetime: 3600)
            let second = try await repository.issue(accountId: accountId, lifetime: 3600)

            try await repository.revoke(token: first.token, accountId: accountId)
            let revoked = try await repository.redeem(token: first.token)
            let sibling = try await repository.redeem(token: second.token)

            #expect(revoked == nil)
            #expect(sibling != nil)
        }
    }

    @Test func `deleteExpired removes only the aged-out rows`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.sessions.cleanup")
            let repository = PostgresSessionRepository(client: client, logger: logger)
            let accountId = try await makeAccount(client: client, logger: logger, name: "cleanup-user")
            let live = try await repository.issue(accountId: accountId, lifetime: 3600)
            _ = try await repository.issue(accountId: accountId, lifetime: -60)

            let deleted = try await repository.deleteExpired(asOf: Date())

            let survivor = try await repository.redeem(token: live.token)
            #expect(deleted == 1)
            #expect(survivor != nil)
        }
    }

    /// The cap is what makes `sessions` bounded at all. `deleteExpired` only ever sees rows that
    /// aged out, and nothing on the connection path deletes a live row — refresh, network loss, and
    /// a normal close all preserve the token deliberately — so without this a scripted login loop
    /// grows the table by a month-lived row per iteration.
    @Test func `issue evicts the oldest sessions beyond the per-account cap`() async throws {
        try await TestHarness.withDatabase { client in
            let logger = Logger(label: "test.sessions.cap")
            let repository = PostgresSessionRepository(client: client, logger: logger)
            let accountId = try await makeAccount(client: client, logger: logger, name: "cap-user")
            let other = try await makeAccount(client: client, logger: logger, name: "cap-bystander")
            let bystander = try await repository.issue(accountId: other, lifetime: 3600)

            // Ascending lifetimes so `expires_at` order matches issue order: the first is oldest.
            var issued: [IssuedSession] = []
            for index in 0 ... SessionPolicy.maxPerAccount {
                try await issued.append(repository.issue(accountId: accountId, lifetime: 3600 + Double(index)))
            }

            // One more than the cap was issued, so exactly the first must be gone and the rest live.
            let evicted = try await repository.redeem(token: issued[0].token)
            #expect(evicted == nil)
            for session in issued.dropFirst() {
                #expect(try await repository.redeem(token: session.token) != nil)
            }
            // Eviction is scoped to the account that crossed the cap.
            #expect(try await repository.redeem(token: bystander.token) != nil)
        }
    }
}
