import Foundation

public struct LeaveMessage: Codable, Sendable, Equatable {
    public var entityIndex: Int16
    public var leftGame: Bool

    public init(entityIndex: Int16, leftGame: Bool) {
        self.entityIndex = entityIndex
        self.leftGame = leftGame
    }

    public enum CodingKeys: String, CaseIterable, CodingKey { case entityIndex; case leftGame }
}
