/// Renderable entity fed to a `WorldRenderSurface`. `id` is the sector-local
/// `entityIndex` the wire protocol uses, so the scene's update calls consume the
/// integer the wire layer already has — there is no UUID translation layer. The
/// scene resets its entity map on `load(sector:)` because the wire's
/// `entityIndex` is sector-local and may be reused after a sector switch.
public struct WorldEntity: Sendable, Identifiable, Equatable, Hashable {
    public enum Kind: Sendable, Equatable, Hashable, CaseIterable {
        case player
        case peer
        case npc
        case monster
    }

    public var id: Int16
    public var kind: Kind
    public var figure: Int16
    public var gender: Gender?
    public var position: GridPoint
    public var facing: Heading
    public var tempo: Tempo
    public var maskSize: GridSize
    public var name: String

    public init(
        id: Int16,
        kind: Kind,
        figure: Int16,
        gender: Gender? = nil,
        position: GridPoint,
        facing: Heading,
        tempo: Tempo,
        maskSize: GridSize,
        name: String
    ) {
        self.id = id
        self.kind = kind
        self.figure = figure
        self.gender = gender
        self.position = position
        self.facing = facing
        self.tempo = tempo
        self.maskSize = maskSize
        self.name = name
    }
}
