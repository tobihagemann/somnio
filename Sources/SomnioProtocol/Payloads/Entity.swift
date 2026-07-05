import Foundation

public enum WireEntityType: Int16, Codable, Sendable, Equatable, Hashable, CaseIterable {
    case player = 0
    case npc = 1
    case monster = 2
}

public struct EntityMessage: Codable, Sendable, Equatable {
    public var entityIndex: Int16
    public var figure: Int16
    public var gender: Int16
    public var maskWidth: Int16
    public var maskHeight: Int16
    public var type: WireEntityType
    public var name: String
    public var x: Int16
    public var y: Int16
    /// Continuous heading in degrees `[0, 360)` (0° = south, 90° = east); the receiver
    /// normalizes via `Heading(degrees:)`.
    public var facing: Float
    public var tempo: Int16

    public init(
        entityIndex: Int16,
        figure: Int16,
        gender: Int16,
        maskWidth: Int16,
        maskHeight: Int16,
        type: WireEntityType,
        name: String,
        x: Int16,
        y: Int16,
        facing: Float,
        tempo: Int16
    ) {
        self.entityIndex = entityIndex
        self.figure = figure
        self.gender = gender
        self.maskWidth = maskWidth
        self.maskHeight = maskHeight
        self.type = type
        self.name = name
        self.x = x
        self.y = y
        self.facing = facing
        self.tempo = tempo
    }
}
