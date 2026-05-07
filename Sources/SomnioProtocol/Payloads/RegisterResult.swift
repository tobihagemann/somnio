import Foundation

public enum RegisterResultCode: Int16, Codable, Sendable, Equatable, Hashable, CaseIterable {
    case ok = 0
    case nicknameExists = 1
    case failure = 2
}

public struct RegisterResultMessage: Codable, Sendable, Equatable {
    public var result: RegisterResultCode

    public init(result: RegisterResultCode) {
        self.result = result
    }

    public enum CodingKeys: String, CaseIterable, CodingKey { case result }
}
