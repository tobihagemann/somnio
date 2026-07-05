import Foundation

/// `PositionMessage` is the shared payload for both `clientPosition` (C→S) and `serverPosition`
/// (S→C broadcast) cases of `SomnioMessage`. The server fills `entityIndex` when broadcasting
/// to peers; the client sends `entityIndex = 0` (server identifies the sender by connection).
public struct PositionMessage: Codable, Sendable, Equatable {
    public var entityIndex: Int16
    public var x: Int16
    public var y: Int16
    /// Continuous heading in degrees `[0, 360)` (0° = south, 90° = east); the receiver
    /// normalizes via `Heading(degrees:)`.
    public var facing: Float
    public var tempo: Int16

    public init(entityIndex: Int16, x: Int16, y: Int16, facing: Float, tempo: Int16) {
        self.entityIndex = entityIndex
        self.x = x
        self.y = y
        self.facing = facing
        self.tempo = tempo
    }
}
