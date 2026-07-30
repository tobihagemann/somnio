import Foundation
import Logging
import SomnioCore
import SomnioData
import SomnioProtocol

/// Login flow: look up the account, verify the password (Argon2id, Task.detached on the
/// hasher's side), fetch the first character + inventory, register with the world router,
/// then emit `loginResult(.ok)` *before* calling `PerSectorActor.attach` which owns the
/// rest of the join sequence (`enterSector` -> `mainCharacter` -> `inventory` -> `energy` ->
/// `entity*`). Both unknown nickname and wrong password return `.badCredentials` and pay
/// the same Argon2id cost via `PasswordHasher.verifyAccountPassword`, so callers can't
/// distinguish the two by response timing.
public enum LoginHandler {
    /// Maximum accepted plaintext password length on inbound login frames. Lifted to
    /// `SomnioProtocolConstants.maxPasswordUTF8Bytes` so the client (which cannot import
    /// SomnioServerCore) can mirror the same cap from the protocol module.
    public static let maxPasswordLength = SomnioProtocolConstants.maxPasswordUTF8Bytes
    /// Maximum accepted nickname length, mirroring `RegisterHandler.maxIdentifierLength`.
    /// Lifted to `SomnioProtocolConstants.maxIdentifierUTF8Bytes`.
    public static let maxNicknameLength = SomnioProtocolConstants.maxIdentifierUTF8Bytes

    public static func handle(
        _ message: LoginMessage,
        on connectionActor: ConnectionActor,
        dependencies: ConnectionDependencies
    ) async {
        let outbox = await connectionActor.connectionOutbox
        let logger = dependencies.logger

        guard message.password.utf8.count <= maxPasswordLength,
              message.nickname.utf8.count <= maxNicknameLength
        else {
            outbox.sendEncoded(.loginResult(LoginResultMessage(result: .badCredentials)), logger: logger)
            return
        }

        do {
            let account = try await dependencies.accounts.findByName(message.nickname)
            let verified = try await dependencies.passwordHasher.verifyAccountPassword(
                message.password,
                against: account?.passwordHash
            )
            guard let account, verified else {
                outbox.sendEncoded(.loginResult(LoginResultMessage(result: .badCredentials)), logger: logger)
                return
            }
            await completeAuthenticatedJoin(
                accountId: account.id,
                on: connectionActor,
                dependencies: dependencies,
                // Strictly request-gated: `requestSessionToken` is Optional and defaults to nil,
                // so a client that never asked receives no `sessionToken` frame at all. That is
                // the invariant keeping `helloVersion` at 3 — an unrecognized inbound tag is
                // fatal to an older client.
                issueSessionToken: message.requestSessionToken == true
            )
        } catch {
            logger.error("login failed", metadata: ["error": "\(error)"])
            outbox.sendEncoded(.loginResult(LoginResultMessage(result: .badCredentials)), logger: logger)
        }
    }

    // swiftlint:disable function_body_length
    /// The join sequence shared by a password login and a redeemed session, so the two cannot
    /// drift: look up the character and inventory, register with the world router, emit
    /// `loginResult(.ok)`, then hand off to `PerSectorActor.attach`.
    static func completeAuthenticatedJoin(
        accountId: UUID,
        on connectionActor: ConnectionActor,
        dependencies: ConnectionDependencies,
        issueSessionToken: Bool
    ) async {
        let outbox = await connectionActor.connectionOutbox
        let logger = dependencies.logger
        do {
            // No account re-fetch: `accountId` arrives already established on both paths — the
            // password path just verified the row, and the redeem path resolved a `sessions` row
            // whose `account_id` foreign key cascades on account deletion, so the row cannot
            // outlive its account. A vanished account still lands on the character guard below with
            // the same `.badCredentials`, and nothing here reads any other account field.
            let characters = try await dependencies.characters.findByAccount(accountId)
            guard let character = characters.first else {
                outbox.sendEncoded(.loginResult(LoginResultMessage(result: .badCredentials)), logger: logger)
                return
            }
            let inventory = try await dependencies.inventories.loadAll(forCharacter: character.id)

            let registered = await dependencies.worldRouter.register(
                actor: connectionActor,
                accountId: accountId,
                characterName: character.name
            )
            guard registered else {
                outbox.sendEncoded(.loginResult(LoginResultMessage(result: .alreadyLoggedIn)), logger: logger)
                return
            }

            guard let sectorActor = await dependencies.worldRouter.sectorActor(named: character.currentSector) else {
                logger.error(
                    "starter sector missing from cache",
                    metadata: ["sector": "\(character.currentSector)"]
                )
                await dependencies.worldRouter.unregister(accountId: accountId)
                outbox.sendEncoded(.loginResult(LoginResultMessage(result: .badCredentials)), logger: logger)
                return
            }

            var resolvedCharacter = character
            let sector = await sectorActor.staticSector
            if let spawn = resolvedSpawn(for: character, in: sector) {
                resolvedCharacter.position = spawn
                resolvedCharacter.lastSeen = Date() // bump so `snapshot`'s stale-write guard accepts the row
                do {
                    _ = try await dependencies.characters.snapshot(resolvedCharacter)
                } catch {
                    logger.warning(
                        "failed to persist resolved spawn point",
                        metadata: ["error": "\(error)", "name": "\(character.name)", "spawn": "(\(spawn.x),\(spawn.y))"]
                    )
                }
            }

            outbox.sendEncoded(.loginResult(LoginResultMessage(result: .ok)), logger: logger)
            do {
                let entityIndex = try await sectorActor.attach(
                    character: resolvedCharacter,
                    inventory: inventory,
                    outbox: outbox
                )
                await connectionActor.markAttached(
                    entityIndex: entityIndex,
                    sectorName: resolvedCharacter.currentSector,
                    accountId: accountId
                )
                // Issued only once the player is *in* the world, not straight after `loginResult.ok`.
                // A token minted before `attach` outlives a join that then threw: the row persists for
                // its full 30-day lifetime while the client — which received `.ok` and no
                // `enterSector` — is torn down, so the credential is a durable side effect of a
                // session that never existed. Nothing revokes it either, because the catch below has
                // no token to name. Ordering it after `markAttached` makes issuance and a live session
                // the same event, which is what the token is a resumption ticket *for*.
                if issueSessionToken {
                    await issueToken(for: accountId, outbox: outbox, dependencies: dependencies)
                }
                // Hand the freshly-attached client the current world clock so the day/night
                // tint applies immediately rather than at the next minute boundary (≤3
                // wall-clock minutes away).
                let dateTick = await dependencies.worldClock.currentDateTickMessage()
                outbox.sendEncoded(.dateTick(dateTick), logger: logger)
            } catch {
                logger.error("failed to attach to sector", metadata: ["error": "\(error)"])
                await dependencies.worldRouter.unregister(accountId: accountId)
                // A second `loginResult`, after the `.ok` this connection already sent. Without it the
                // client sits in `awaitingEnterSector` forever: it was told the credentials were good,
                // the join sequence never arrives, and neither client has a timeout on that state — so
                // the failure reads as an indefinite hang with no message and no login form to retry
                // from. `.badCredentials` is the one terminal code both clients act on identically
                // (`ClientViewModel.handleLoginResult` and the browser's `handleLoginResult` both
                // append a chat line, tear the socket down, and re-present the login overlay), which
                // is what turns a wedged client into one the player can act on. It is deliberately
                // not a new result code: adding one would be a required-key wire change and a
                // `helloVersion` bump, locking out every released player over a branch that fires only
                // on sector-index exhaustion or an oversized `enterSector` frame.
                outbox.sendEncoded(.loginResult(LoginResultMessage(result: .badCredentials)), logger: logger)
            }
        } catch {
            logger.error("join failed", metadata: ["error": "\(error)"])
            outbox.sendEncoded(.loginResult(LoginResultMessage(result: .badCredentials)), logger: logger)
        }
    }

    // swiftlint:enable function_body_length

    /// Issues a resumable token and puts the raw value on the wire — the only time it exists
    /// outside the client. A failure here is logged and swallowed: the player is already
    /// authenticated, so losing token issuance must not cost them the session.
    ///
    /// Called only after `markAttached`, so a persisted token always corresponds to a session that
    /// actually reached the world. See the call site for why the reverse order left a 30-day
    /// credential behind a join that threw.
    private static func issueToken(
        for accountId: UUID,
        outbox: ConnectionOutbox,
        dependencies: ConnectionDependencies
    ) async {
        do {
            let session = try await dependencies.sessions.issue(
                accountId: accountId,
                lifetime: SessionPolicy.defaultLifetime
            )
            let remaining = session.expiresAt.timeIntervalSinceNow
            outbox.sendEncoded(
                .sessionToken(SessionTokenMessage(
                    token: session.token,
                    expiresInSeconds: Int32(max(0, remaining.rounded()))
                )),
                logger: dependencies.logger
            )
        } catch {
            dependencies.logger.warning("session token issuance failed", metadata: ["error": "\(error)"])
        }
    }

    /// Self-healing spawn point used when the persisted position is unwalkable (out of bounds
    /// or inside a collision mask). Returns `nil` when the position is already walkable (no
    /// correction needed). It catches fresh characters (registration writes the `(0, 0)`
    /// sentinel, which sits inside the north-wall mask) and any row stuck inside geometry or
    /// off-map from before the spawn-resolution wiring. A character can never be legitimately
    /// saved unwalkable under normal play (movement into masks and out of bounds is blocked),
    /// so "unwalkable" is a reliable corruption signal. Prefers the sector's arrival portal,
    /// falling back to its pixel-space center when no walkable arrival cell is found (the
    /// sector has no arrival portal, or its portal rect is fully blocked by collision masks).
    static func resolvedSpawn(for character: Character, in sector: Sector) -> GridPoint? {
        guard !sector.isWalkable(character.position) else {
            return nil
        }
        return sector.arrivalSpawn ?? sector.pixelCenter
    }
}
