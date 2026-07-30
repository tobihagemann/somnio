import Foundation
import SomnioProtocol
import SomnioTestSupport
import Testing
@testable import SomnioServerCore

/// Pins **which** of `ConnectionActor`'s two exhaustive switches accepts each session tag.
///
/// This is the failure mode the split is most exposed to: because the project forbids
/// `default:` on project-defined enums, adding a tag forces a decision in both switches — but
/// the compiler is equally happy with the wrong one. Putting `revokeSession` in the pre-login
/// switch makes logout close the connection with a protocol error, leaving exactly the working
/// credential in browser storage that revocation exists to remove, and nothing about that
/// fails to compile.
///
/// `ConnectionActorDispatchTests` covers the mirror image (each tag rejected in the wrong
/// state); together the two suites bracket the placement from both sides.
struct ConnectionActorSessionPlacementTests {
    @Test func `redeemSession is accepted before login`() async throws {
        let connection = try await ConnectionActor(dependencies: makeStubConnectionDependencies())

        let decision = await connection.dispatch(.redeemSession(RedeemSessionMessage(token: "tok")), frameSize: 0)

        guard case .keepOpen = decision else {
            Issue.record("redeemSession must be accepted pre-login, got \(decision)")
            return
        }
    }

    @Test func `revokeSession is accepted after attach`() async throws {
        let connection = try await ConnectionActor(dependencies: makeStubConnectionDependencies())
        await connection.markAttached(entityIndex: 1, sectorName: "EdariaBibliothek", accountId: UUID())

        let decision = await connection.dispatch(.revokeSession(RevokeSessionMessage(token: "tok")), frameSize: 0)

        guard case .keepOpen = decision else {
            Issue.record("revokeSession must be accepted post-attach, got \(decision)")
            return
        }
    }

    /// An unknown token resolves nothing and must answer `.badCredentials` rather than closing — the
    /// same response an expired or revoked token gets, so the client cannot tell the three apart.
    @Test func `an unresolvable token answers badCredentials without closing`() async throws {
        let dependencies = try await makeStubConnectionDependencies()
        let connection = ConnectionActor(dependencies: dependencies)
        let outbox = await connection.connectionOutbox

        let decision = await connection.dispatch(.redeemSession(RedeemSessionMessage(token: "nope")), frameSize: 0)
        outbox.finish()

        guard case .keepOpen = decision else {
            Issue.record("a failed redemption must not close the connection, got \(decision)")
            return
        }
        #expect(await loginResults(from: outbox) == [.badCredentials])
    }

    /// Revocation always acknowledges, even when no row was removed. A silent revoke would leave
    /// the client waiting on a frame that never arrives.
    @Test func `revocation acknowledges even when nothing was removed`() async throws {
        let dependencies = try await makeStubConnectionDependencies()
        let connection = ConnectionActor(dependencies: dependencies)
        await connection.markAttached(entityIndex: 1, sectorName: "EdariaBibliothek", accountId: UUID())
        let outbox = await connection.connectionOutbox

        _ = await connection.dispatch(.revokeSession(RevokeSessionMessage(token: "tok")), frameSize: 0)
        outbox.finish()

        let tags = await collectTags(from: outbox)
        #expect(tags.contains(.sessionRevoked))
    }

    /// The token cap is a pre-login guard, so it has to reject *before* the repository is reached.
    /// Asserting only the response would pass while an unauthenticated frame drove an unbounded
    /// digest over attacker-supplied bytes.
    @Test func `an over-cap token is refused without reaching the repository`() async throws {
        let sessions = StubSessionRepository()
        let accountId = UUID()
        let issued = try await sessions.issue(accountId: accountId, lifetime: 60)
        let dependencies = try await makeStubConnectionDependencies(sessions: sessions)
        let connection = ConnectionActor(dependencies: dependencies)
        let outbox = await connection.connectionOutbox

        let oversized = String(repeating: "a", count: SomnioProtocolConstants.maxSessionTokenUTF8Bytes + 1)
        let decision = await connection.dispatch(.redeemSession(RedeemSessionMessage(token: oversized)), frameSize: 0)
        outbox.finish()

        guard case .keepOpen = decision else {
            Issue.record("an over-cap token must not close the connection, got \(decision)")
            return
        }
        #expect(await collectTags(from: outbox).contains(.loginResult))
        // The stored token is untouched: nothing about an oversized frame should disturb it.
        #expect(await sessions.isStored(token: issued.token))
        // The load-bearing half, and the reason this test's name says "without reaching the
        // repository": the response is `badCredentials` either way, so only the call count
        // distinguishes a guard that fired from a lookup that merely missed.
        #expect(await sessions.redeemCallCount == 0)
    }

    /// The revoke path carries the identical cap with the identical rationale, and is the half
    /// reachable while *authenticated* — so it needs the same call-count assertion. `revoked: false`
    /// is the answer whether the guard fired or the lookup missed, which is exactly why the response
    /// alone cannot tell the two apart.
    @Test func `an over-cap revoke token is refused without reaching the repository`() async throws {
        let sessions = StubSessionRepository()
        let accountId = UUID()
        let issued = try await sessions.issue(accountId: accountId, lifetime: 3600)
        let dependencies = try await makeStubConnectionDependencies(sessions: sessions)
        let connection = ConnectionActor(dependencies: dependencies)
        await connection.markAttached(entityIndex: 1, sectorName: "EdariaBibliothek", accountId: accountId)
        let outbox = await connection.connectionOutbox

        let oversized = String(repeating: "a", count: SomnioProtocolConstants.maxSessionTokenUTF8Bytes + 1)
        let decision = await connection.dispatch(.revokeSession(RevokeSessionMessage(token: oversized)), frameSize: 0)
        outbox.finish()

        guard case .keepOpen = decision else {
            Issue.record("an over-cap token must not close the connection, got \(decision)")
            return
        }
        #expect(await collectTags(from: outbox).contains(.sessionRevoked))
        #expect(await sessions.isStored(token: issued.token))
        #expect(await sessions.revokeCallCount == 0)
    }

    /// Revocation is scoped to the connection's own account. Without the scope any attached player
    /// could destroy another account's session by presenting a token they merely obtained.
    @Test func `revocation refuses a token belonging to another account`() async throws {
        let sessions = StubSessionRepository()
        let victim = try await sessions.issue(accountId: UUID(), lifetime: 3600)
        let dependencies = try await makeStubConnectionDependencies(sessions: sessions)
        let connection = ConnectionActor(dependencies: dependencies)
        await connection.markAttached(entityIndex: 1, sectorName: "EdariaBibliothek", accountId: UUID())
        let outbox = await connection.connectionOutbox

        _ = await connection.dispatch(.revokeSession(RevokeSessionMessage(token: victim.token)), frameSize: 0)
        outbox.finish()

        #expect(await collectTags(from: outbox).contains(.sessionRevoked))
        // The row survives — the acknowledgement said `revoked: false` rather than deleting it.
        #expect(await sessions.isStored(token: victim.token))
    }

    /// The owner's own logout does remove the row, so a truthful acknowledgement is not the same as
    /// an unconditional one.
    @Test func `revocation removes the connection's own token`() async throws {
        let sessions = StubSessionRepository()
        let accountId = UUID()
        let issued = try await sessions.issue(accountId: accountId, lifetime: 3600)
        let dependencies = try await makeStubConnectionDependencies(sessions: sessions)
        let connection = ConnectionActor(dependencies: dependencies)
        await connection.markAttached(entityIndex: 1, sectorName: "EdariaBibliothek", accountId: accountId)
        let outbox = await connection.connectionOutbox

        _ = await connection.dispatch(.revokeSession(RevokeSessionMessage(token: issued.token)), frameSize: 0)
        outbox.finish()

        #expect(await collectTags(from: outbox).contains(.sessionRevoked))
        #expect(await sessions.isStored(token: issued.token) == false)
    }

    /// An expired token is indistinguishable from an unknown one, which is the documented contract.
    @Test func `an expired token answers badCredentials`() async throws {
        let sessions = StubSessionRepository()
        await sessions.plant(token: "aged", accountId: UUID(), expiresAt: Date(timeIntervalSinceNow: -60))
        let dependencies = try await makeStubConnectionDependencies(sessions: sessions)
        let connection = ConnectionActor(dependencies: dependencies)
        let outbox = await connection.connectionOutbox

        _ = await connection.dispatch(.redeemSession(RedeemSessionMessage(token: "aged")), frameSize: 0)
        outbox.finish()

        #expect(await loginResults(from: outbox) == [.badCredentials])
    }

    /// The `loginResult` codes a run produced, so a test can assert *which* answer came back.
    /// `collectTags` alone cannot: every redemption outcome emits a `loginResult`, so a tag check
    /// passes whether the token resolved, was refused, or was never looked at.
    private func loginResults(from outbox: ConnectionOutbox) async -> [LoginResultCode] {
        await collect(outbox: outbox).compactMap { frame in
            guard case let .loginResult(payload)? = try? SomnioMessageDecoder.decode(frame) else { return nil }
            return payload.result
        }
    }

    private func collectTags(from outbox: ConnectionOutbox) async -> [SomnioMessageTag] {
        await collect(outbox: outbox).compactMap { try? SomnioMessageDecoder.decode($0).tag }
    }
}
