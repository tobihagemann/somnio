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
            let characters = try await dependencies.characters.findByAccount(account.id)
            guard let character = characters.first else {
                outbox.sendEncoded(.loginResult(LoginResultMessage(result: .badCredentials)), logger: logger)
                return
            }
            let inventory = try await dependencies.inventories.loadAll(forCharacter: character.id)

            let registered = await dependencies.worldRouter.register(
                actor: connectionActor,
                accountId: account.id,
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
                await dependencies.worldRouter.unregister(accountId: account.id)
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
                    accountId: account.id
                )
                // Hand the freshly-attached client the current world clock so the day/night
                // tint applies immediately rather than at the next minute boundary (≤3
                // wall-clock minutes away).
                let dateTick = await dependencies.worldClock.currentDateTickMessage()
                outbox.sendEncoded(.dateTick(dateTick), logger: logger)
            } catch {
                logger.error("failed to attach to sector", metadata: ["error": "\(error)"])
                await dependencies.worldRouter.unregister(accountId: account.id)
            }
        } catch {
            logger.error("login failed", metadata: ["error": "\(error)"])
            outbox.sendEncoded(.loginResult(LoginResultMessage(result: .badCredentials)), logger: logger)
        }
    }

    /// Self-healing spawn point used when the persisted position is unwalkable (out of bounds
    /// or inside a collision mask). Returns `nil` when the position is already walkable (no
    /// correction needed). It catches fresh characters (registration writes the `(0, 0)`
    /// sentinel, which sits inside the north-wall mask) and any row stuck inside geometry or
    /// off-map from before the spawn-resolution wiring. A character can never be legitimately
    /// saved unwalkable under normal play (movement into masks and out of bounds is blocked),
    /// so "unwalkable" is a reliable corruption signal. Prefers the sector's arrival portal,
    /// falling back to its pixel-space center when the sector has no arrival portal.
    static func resolvedSpawn(for character: Character, in sector: Sector) -> GridPoint? {
        guard !sector.isWalkable(character.position) else {
            return nil
        }
        return sector.arrivalSpawn ?? sector.pixelCenter
    }
}
