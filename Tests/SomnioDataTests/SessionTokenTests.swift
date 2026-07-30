import Foundation
import SomnioTestSupport
import Testing
@testable import SomnioData

/// Pure token-and-digest coverage. The Postgres-backed issue/redeem/expiry/revoke paths need a
/// live database and live in the integration suite; everything here runs in `swift test`.
struct SessionTokenTests {
    @Test func `tokens are URL-safe base64 without padding`() {
        let token = PostgresSessionRepository.makeToken()
        #expect(!token.contains("+"))
        #expect(!token.contains("/"))
        #expect(!token.contains("="))
        #expect(token.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })
    }

    /// 256 bits encode to 43 base64 characters once padding is stripped. The entropy is what
    /// makes the unsalted digest safe — there is no guessable structure to grind against, so the
    /// slow-KDF property a password hash would buy is worthless here.
    @Test func `tokens carry 256 bits of entropy`() {
        #expect(PostgresSessionRepository.makeToken().count == 43)
    }

    @Test func `tokens do not repeat`() {
        let tokens = Set((0 ..< 256).map { _ in PostgresSessionRepository.makeToken() })
        #expect(tokens.count == 256)
    }

    /// The digest is what lands in the column, never the token. A stored value that contained
    /// the raw token would make a database read directly replayable as a credential.
    @Test func `the digest is not the token`() {
        let token = PostgresSessionRepository.makeToken()
        let digest = PostgresSessionRepository.digest(of: token)
        #expect(digest != token)
        #expect(!digest.contains(token))
    }

    @Test func `the digest is a stable hex SHA-256`() {
        // Pinned against the published SHA-256 of the empty string, so a swapped hash function
        // or a changed encoding fails loudly rather than silently invalidating every stored row.
        #expect(
            PostgresSessionRepository.digest(of: "")
                == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        )
        #expect(PostgresSessionRepository.digest(of: "abc").count == 64)
    }

    @Test func `the digest is deterministic and unsalted`() {
        // Unsalted on purpose: redemption looks the row up *by* digest, and a salted hash is not
        // searchable — it would force a scan-and-verify over every row.
        let token = "a-fixed-token"
        #expect(PostgresSessionRepository.digest(of: token) == PostgresSessionRepository.digest(of: token))
        #expect(PostgresSessionRepository.digest(of: "other") != PostgresSessionRepository.digest(of: token))
    }

    @Test func `the default lifetime is 30 days`() {
        #expect(SessionPolicy.defaultLifetime == 30 * 24 * 60 * 60)
    }

    /// Fixture fidelity, not production behaviour.
    ///
    /// The name matters: this exercises `StubSessionRepository`'s in-memory reimplementation, not
    /// `PostgresSessionRepository`, so it can say nothing about the real `DELETE`. That belongs to
    /// the integration tier and lives there (`SessionRepositoryTests.deleteExpired removes only the
    /// aged-out rows`). What it *is* worth pinning is that the double agrees with the real thing,
    /// because the handler tests in `SomnioServerCoreTests` reach their expiry branches only through
    /// this stub — a stub that kept expired rows would make those tests assert nothing.
    @Test func `the stub sweep mirrors the repository: expired rows go, live ones stay`() async throws {
        let repository = StubSessionRepository()
        let accountId = UUID()
        let live = try await repository.issue(accountId: accountId, lifetime: 3600)
        await repository.plant(token: "aged", accountId: accountId, expiresAt: Date(timeIntervalSinceNow: -1))

        let deleted = try await repository.deleteExpired(asOf: Date())

        #expect(deleted == 1)
        #expect(await repository.isStored(token: "aged") == false)
        #expect(await repository.isStored(token: live.token))
    }

    /// The fail-closed stand-in: no repository wired means no tokens issued, rather than tokens
    /// issued that nothing can revoke.
    @Test func `the disabled repository refuses to issue and resolves nothing`() async throws {
        let repository = DisabledSessionRepository()
        await #expect(throws: SessionRepositoryError.sessionsDisabled) {
            _ = try await repository.issue(accountId: UUID(), lifetime: 60)
        }
        let resolved = try await repository.redeem(token: "anything")
        let revoked = try await repository.revoke(token: "anything", accountId: UUID())
        let purged = try await repository.deleteExpired(asOf: Date())
        #expect(resolved == nil)
        #expect(revoked == false)
        #expect(purged == 0)
    }
}
