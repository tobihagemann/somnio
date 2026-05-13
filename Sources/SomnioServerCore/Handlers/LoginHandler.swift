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
    /// Maximum accepted plaintext password length on inbound login frames. Password length
    /// caps the Argon2id input cost; without this an unauthenticated attacker can pipeline
    /// 64 KB password frames to saturate the cooperative hasher pool.
    public static let maxPasswordLength = 128
    /// Mirrors `RegisterHandler.maxIdentifierLength`. Login can't accept a nickname the
    /// register handler would reject — and the symmetric cap prevents an attacker from
    /// shipping a near-1 MiB nickname that pays Postgres `LOWER(NORMALIZE(..., NFKC))` cost
    /// plus full Argon2 verify cost on the unknown-account path.
    public static let maxNicknameLength = RegisterHandler.maxIdentifierLength

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

            outbox.sendEncoded(.loginResult(LoginResultMessage(result: .ok)), logger: logger)
            do {
                let entityIndex = try await sectorActor.attach(
                    character: character,
                    inventory: inventory,
                    outbox: outbox
                )
                await connectionActor.markAttached(
                    entityIndex: entityIndex,
                    sectorName: character.currentSector,
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
}
