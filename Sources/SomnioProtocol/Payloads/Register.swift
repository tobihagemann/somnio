import Foundation

public struct RegisterMessage: Codable, Sendable, Equatable {
    public var nickname: String
    public var password: String
    public var passwordRepeat: String
    public var characterClass: Int16
    public var gender: Int16
    public var email: String

    public init(
        nickname: String,
        password: String,
        passwordRepeat: String,
        characterClass: Int16,
        gender: Int16,
        email: String
    ) {
        self.nickname = nickname
        self.password = password
        self.passwordRepeat = passwordRepeat
        self.characterClass = characterClass
        self.gender = gender
        self.email = email
    }

    public enum CodingKeys: String, CaseIterable, CodingKey {
        case nickname; case password; case passwordRepeat
        case characterClass; case gender; case email
    }
}
