import Foundation

public enum RegisterResultCode: Int16, Codable, Sendable, Equatable, Hashable, CaseIterable {
    case ok = 0
    case nicknameExists = 1
    case failure = 2
    /// The name tripped the confusable / script-mixing policy (`NamePolicy.validateForRegistration`).
    /// Distinct from `failure` so the client can show a name-specific message; the wire copy stays
    /// generic so a probing client learns nothing about the exact rule.
    case nameNotAllowed = 3
}

public struct RegisterResultMessage: Codable, Sendable, Equatable {
    public var result: RegisterResultCode

    public init(result: RegisterResultCode) {
        self.result = result
    }
}
