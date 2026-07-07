import Foundation
import SomnioCore

/// Inline registration error surfaced by the server. Mirrors the typed-message
/// pattern the rest of the project follows (`ChatLine`, `LoginResultCode`,
/// `RegisterResultCode`) so adding a new server-side outcome is a build-time error
/// at every dispatch site rather than a runtime catalog miss.
public enum RegistrationError: Sendable, Equatable {
    case nicknameExists
    case nameNotAllowed
    case failure
}

/// Mutable registration-overlay state held by `ClientViewModel`. `lastError` is
/// populated when the server replies with `.nicknameExists` or `.failure` so the
/// overlay can surface the inline error without rendering it through the chat
/// scrollback.
@Observable public final class RegistrationFormState {
    public var nickname: String = ""
    public var password: String = ""
    public var passwordRepeat: String = ""
    public var characterClass: CharacterClass = .fighter
    public var gender: Gender = .male
    public var email: String = ""
    public var lastError: RegistrationError?

    public init() {}

    public func clear() {
        nickname = ""
        password = ""
        passwordRepeat = ""
        characterClass = .fighter
        gender = .male
        email = ""
        lastError = nil
    }
}
