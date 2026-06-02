import Foundation

public struct MainCharacterMessage: Codable, Sendable, Equatable {
    public var entityIndex: Int16

    public init(entityIndex: Int16) {
        self.entityIndex = entityIndex
    }
}
