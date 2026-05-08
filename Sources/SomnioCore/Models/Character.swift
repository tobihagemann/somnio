import Foundation

public struct Character: Sendable, Identifiable, Equatable, Hashable {
    public var id: UUID
    public var name: String
    public var figure: Int16
    public var gender: Gender
    public var currentSector: String
    public var position: GridPoint
    public var facing: Direction
    public var tempo: Tempo
    public var energy: Energy
    public var lastSeen: Date

    public init(
        id: UUID = UUID(),
        name: String,
        figure: Int16,
        gender: Gender,
        currentSector: String,
        position: GridPoint,
        facing: Direction,
        tempo: Tempo,
        energy: Energy,
        lastSeen: Date
    ) {
        self.id = id
        self.name = name
        self.figure = figure
        self.gender = gender
        self.currentSector = currentSector
        self.position = position
        self.facing = facing
        self.tempo = tempo
        self.energy = energy
        self.lastSeen = lastSeen
    }
}
