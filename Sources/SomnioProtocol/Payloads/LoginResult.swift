import Foundation

public enum LoginResultCode: Int16, Codable, Sendable, Equatable, Hashable, CaseIterable {
    case ok = 0
    case badCredentials = 1
    case alreadyLoggedIn = 2
}

public struct LoginResultMessage: Codable, Sendable, Equatable {
    public var result: LoginResultCode

    public init(result: LoginResultCode) {
        self.result = result
    }

    public enum CodingKeys: String, CaseIterable, CodingKey { case result }
}
