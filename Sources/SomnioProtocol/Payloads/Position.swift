import Foundation

/// `PositionMessage` is the shared payload for both `clientPosition` (C→S) and `serverPosition`
/// (S→C broadcast) cases of `SomnioMessage`. The server fills `entityIndex` when broadcasting
/// to peers; the client sends `entityIndex = 0` (server identifies the sender by connection).
public struct PositionMessage: Codable, Sendable, Equatable {
    public var entityIndex: Int16
    public var x: Int16
    public var y: Int16
    public var facing: Int16
    public var tempo: Int16

    public init(entityIndex: Int16, x: Int16, y: Int16, facing: Int16, tempo: Int16) {
        self.entityIndex = entityIndex
        self.x = x
        self.y = y
        self.facing = facing
        self.tempo = tempo
    }

    public enum CodingKeys: String, CaseIterable, CodingKey {
        case entityIndex; case x; case y; case facing; case tempo
    }
}
