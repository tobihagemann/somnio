import Foundation
import Logging
import SomnioData
import SomnioProtocol

/// Session resumption: redeeming a token in place of a password login, and revoking it on logout.
///
/// Redemption reuses `LoginHandler`'s join sequence rather than duplicating it, so a resumed
/// connection is indistinguishable from a fresh login downstream. Every failure — unknown,
/// expired, or revoked — answers `.badCredentials`, deliberately telling the client nothing
/// about which.
public enum SessionHandler {
    public static func handleRedeem(
        _ message: RedeemSessionMessage,
        on connectionActor: ConnectionActor,
        dependencies: ConnectionDependencies
    ) async {
        let outbox = await connectionActor.connectionOutbox
        let logger = dependencies.logger

        // Bound the inbound token the same way credentials are bounded: a frame must not be able to
        // drive an unbounded digest over attacker-supplied bytes.
        guard message.token.utf8.count <= SomnioProtocolConstants.maxSessionTokenUTF8Bytes else {
            outbox.sendEncoded(.loginResult(LoginResultMessage(result: .badCredentials)), logger: logger)
            return
        }

        do {
            guard let resolved = try await dependencies.sessions.redeem(token: message.token) else {
                outbox.sendEncoded(.loginResult(LoginResultMessage(result: .badCredentials)), logger: logger)
                return
            }
            await LoginHandler.completeAuthenticatedJoin(
                accountId: resolved.accountId,
                on: connectionActor,
                dependencies: dependencies,
                // Redemption does **not** rotate the token. Rotating would have to happen only
                // after `WorldRouter.register` succeeds, because rotating earlier invalidates the
                // credential on the first `alreadyLoggedIn` response and silently breaks the
                // client's bounded refresh retry. Not rotating sidesteps that interaction
                // entirely; the token's own expiry remains the bound on its lifetime.
                issueSessionToken: false
            )
        } catch {
            logger.error("session redemption failed", metadata: ["error": "\(error)"])
            outbox.sendEncoded(.loginResult(LoginResultMessage(result: .badCredentials)), logger: logger)
        }
    }

    /// Revocation is its own request-gated message with an acknowledgement, never a side effect
    /// of disconnect: refresh, network loss, and a normal close must all *preserve* the token,
    /// since resuming across exactly those events is the point. Only an explicit logout destroys
    /// it, and only the token presented on this connection.
    ///
    /// `accountId` comes from the connection's own `attached` state and scopes the delete, which is
    /// what makes the second half of that sentence true. Matching on the digest alone would let any
    /// attached player destroy *another* account's session by presenting a token they had merely
    /// obtained — a shared machine's `localStorage`, a support screenshot — without ever
    /// authenticating as them. It also keeps the `revoked: false` acknowledgement from doubling as
    /// an existence oracle for arbitrary tokens.
    public static func handleRevoke(
        _ message: RevokeSessionMessage,
        accountId: UUID,
        on connectionActor: ConnectionActor,
        dependencies: ConnectionDependencies
    ) async {
        let outbox = await connectionActor.connectionOutbox
        let logger = dependencies.logger

        // Bounded like the redeem path. This frame is authenticated, but the project caps
        // authenticated fields too (`clientSay`, admin-say), and an unbounded digest is an
        // unbounded digest either way.
        guard message.token.utf8.count <= SomnioProtocolConstants.maxSessionTokenUTF8Bytes else {
            outbox.sendEncoded(.sessionRevoked(SessionRevokedMessage(revoked: false)), logger: logger)
            return
        }

        do {
            let removed = try await dependencies.sessions.revoke(token: message.token, accountId: accountId)
            outbox.sendEncoded(.sessionRevoked(SessionRevokedMessage(revoked: removed)), logger: logger)
        } catch {
            logger.error("session revocation failed", metadata: ["error": "\(error)"])
            // Report the failure honestly. The client clears local storage either way, so a lost
            // acknowledgement never leaves the UI claiming a session it cannot verify.
            outbox.sendEncoded(.sessionRevoked(SessionRevokedMessage(revoked: false)), logger: logger)
        }
    }
}
