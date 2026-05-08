import Foundation

public struct Account: Sendable, Identifiable, Equatable, Hashable {
    public var id: UUID
    public var name: String
    public var passwordHash: String
    public var email: String
    public var createdAt: Date

    public init(
        id: UUID = UUID(),
        name: String,
        passwordHash: String,
        email: String,
        createdAt: Date
    ) {
        self.id = id
        self.name = name
        self.passwordHash = passwordHash
        self.email = email
        self.createdAt = createdAt
    }
}
