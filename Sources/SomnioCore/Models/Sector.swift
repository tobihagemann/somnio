import Foundation

/// Parsed sector contents *without* a name. `MapCodec.read` returns this — naming a sector
/// requires context the codec doesn't have (the file path, an asset key, the editor document
/// title), so the type system forces the caller to provide it via `Sector(body:, name:)`.
public struct SectorBody: Sendable, Equatable {
    public var version: Int16
    public var dimensions: GridSize
    public var ground: GroundTile
    public var light: LightSetting
    public var objects: [Object]
    public var collisionMasks: [CollisionMask]
    public var portals: [SectorPortal]
    public var npcs: [NPC]
    public var monsterSpawns: [MonsterSpawn]

    public init(
        version: Int16,
        dimensions: GridSize,
        ground: GroundTile,
        light: LightSetting,
        objects: [Object] = [],
        collisionMasks: [CollisionMask] = [],
        portals: [SectorPortal] = [],
        npcs: [NPC] = [],
        monsterSpawns: [MonsterSpawn] = []
    ) {
        self.version = version
        self.dimensions = dimensions
        self.ground = ground
        self.light = light
        self.objects = objects
        self.collisionMasks = collisionMasks
        self.portals = portals
        self.npcs = npcs
        self.monsterSpawns = monsterSpawns
    }
}

public struct Sector: Sendable, Equatable {
    public var name: String
    public var version: Int16
    public var dimensions: GridSize
    public var ground: GroundTile
    public var light: LightSetting
    public var objects: [Object]
    public var collisionMasks: [CollisionMask]
    public var portals: [SectorPortal]
    public var npcs: [NPC]
    public var monsterSpawns: [MonsterSpawn]

    public init(
        name: String,
        version: Int16,
        dimensions: GridSize,
        ground: GroundTile,
        light: LightSetting,
        objects: [Object] = [],
        collisionMasks: [CollisionMask] = [],
        portals: [SectorPortal] = [],
        npcs: [NPC] = [],
        monsterSpawns: [MonsterSpawn] = []
    ) {
        self.name = name
        self.version = version
        self.dimensions = dimensions
        self.ground = ground
        self.light = light
        self.objects = objects
        self.collisionMasks = collisionMasks
        self.portals = portals
        self.npcs = npcs
        self.monsterSpawns = monsterSpawns
    }

    public init(body: SectorBody, name: String) {
        self.init(
            name: name,
            version: body.version,
            dimensions: body.dimensions,
            ground: body.ground,
            light: body.light,
            objects: body.objects,
            collisionMasks: body.collisionMasks,
            portals: body.portals,
            npcs: body.npcs,
            monsterSpawns: body.monsterSpawns
        )
    }

    public var body: SectorBody {
        SectorBody(
            version: version,
            dimensions: dimensions,
            ground: ground,
            light: light,
            objects: objects,
            collisionMasks: collisionMasks,
            portals: portals,
            npcs: npcs,
            monsterSpawns: monsterSpawns
        )
    }
}
