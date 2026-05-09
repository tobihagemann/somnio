import Foundation
import Logging
import SomnioCore
import SomnioData
import SomnioProtocol

/// Registration flow: validate raws (passwords match, length-bounded fields, recognized
/// class + gender), derive the class-bounded sprite figure, hash the password, then call
/// the transactional `RegistrationRepository`. The unique-constraint race maps
/// `nicknameTaken` -> `nicknameExists`; any other error logs and maps to `.failure`. There
/// is no pre-check `findByName` round-trip — the constraint is the source of truth.
public enum RegisterHandler {
    /// Minimum plaintext password length (NIST SP 800-63B §5.1.1.2 baseline). Trades off
    /// against UX migration: accounts created before this floor still authenticate via the
    /// stored Argon2id PHC string.
    public static let minPasswordLength = 8
    /// Upper bound mirroring `LoginHandler.maxPasswordLength`; caps the Argon2id input cost
    /// an unauthenticated frame can request.
    public static let maxPasswordLength = LoginHandler.maxPasswordLength
    /// Cap on `nickname`/`email` length so an oversized GENERATED-column input can't blow up
    /// transactional INSERT cost or trip storage policies upstream.
    public static let maxIdentifierLength = 64

    public static func handle(
        _ message: RegisterMessage,
        on connectionActor: ConnectionActor,
        dependencies: ConnectionDependencies
    ) async {
        let outbox = await connectionActor.connectionOutbox
        let logger = dependencies.logger

        let passwordLength = message.password.utf8.count
        guard message.password == message.passwordRepeat,
              passwordLength >= minPasswordLength,
              passwordLength <= maxPasswordLength,
              !message.email.isEmpty,
              message.email.utf8.count <= maxIdentifierLength,
              !message.nickname.isEmpty,
              message.nickname.utf8.count <= maxIdentifierLength,
              let characterClass = CharacterClass(rawValue: message.characterClass),
              let gender = Gender(rawValue: message.gender)
        else {
            outbox.sendEncoded(.registerResult(RegisterResultMessage(result: .failure)), logger: logger)
            return
        }
        let figure = SpriteFigure.figureIndex(class: characterClass, gender: gender)
        let passwordHash: String
        do {
            passwordHash = try await dependencies.passwordHasher.hash(message.password)
        } catch {
            logger.error("failed to hash registration password", metadata: ["error": "\(error)"])
            outbox.sendEncoded(.registerResult(RegisterResultMessage(result: .failure)), logger: logger)
            return
        }
        do {
            _ = try await dependencies.registrations.register(
                name: message.nickname,
                passwordHash: passwordHash,
                email: message.email,
                gender: gender,
                figure: figure,
                starterInventory: StarterInventory.rows
            )
            outbox.sendEncoded(.registerResult(RegisterResultMessage(result: .ok)), logger: logger)
        } catch RegistrationError.nicknameTaken {
            outbox.sendEncoded(.registerResult(RegisterResultMessage(result: .nicknameExists)), logger: logger)
        } catch {
            logger.error("registration failed", metadata: ["error": "\(error)"])
            outbox.sendEncoded(.registerResult(RegisterResultMessage(result: .failure)), logger: logger)
        }
    }
}
