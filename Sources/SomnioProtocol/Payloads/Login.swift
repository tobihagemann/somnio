import Foundation

public struct LoginMessage: Codable, Sendable, Equatable {
    public var nickname: String
    public var password: String

    public init(nickname: String, password: String) {
        self.nickname = nickname
        self.password = password
    }

    public enum CodingKeys: String, CaseIterable, CodingKey { case nickname; case password }
}
