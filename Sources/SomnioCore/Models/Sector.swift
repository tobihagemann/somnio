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

    /// Pixel extent of the sector. `dimensions` is in tiles; positions and collision masks
    /// are in pixels. Widened to `Int32` so a large sector cannot trap the multiply.
    public var pixelWidth: Int32 {
        Int32(dimensions.width) * Int32(SomnioConstants.tileSize)
    }

    public var pixelHeight: Int32 {
        Int32(dimensions.height) * Int32(SomnioConstants.tileSize)
    }

    /// Sector center in pixel space, clamped into `Int16`. Spawn fallback when a sector has
    /// no arrival portal.
    public var pixelCenter: GridPoint {
        GridPoint(x: Int16(clamping: pixelWidth / 2), y: Int16(clamping: pixelHeight / 2))
    }

    /// True when `position` is in the sector's pixel bounds and clear of every collision mask
    /// — a standable pixel.
    public func isWalkable(_ position: GridPoint) -> Bool {
        position.x >= 0 && position.y >= 0
            && Int32(position.x) < pixelWidth && Int32(position.y) < pixelHeight
            && !CollisionMaskOverlap.contains(position, in: collisionMasks)
    }

    /// Spawn point inside the self-pointing arrival-placement portal (legacy "Hierhin"
    /// record), in pixel coordinates. The legacy server uses this as the spawn point for
    /// new characters and as the login destination. Prefers the portal's geometric center,
    /// but the portal rect can span collision masks (e.g., a bookshelf row crosses it), so
    /// when the center is blocked this scans the portal on an 8px grid and returns the
    /// walkable cell closest to the center. Returns `nil` if the sector has no arrival
    /// portal targeting itself — callers should fall back to the sector's pixel-space
    /// center in that case.
    public var arrivalSpawn: GridPoint? {
        guard let portal = portals.first(where: { $0.direction == .arrivalPlacement && $0.targetSectorName == name }) else {
            return nil
        }
        // Widen to `Int32` throughout so a malformed authored portal near `Int16.max` cannot
        // trap the center/bounds arithmetic; clamp candidates back into the `Int16` GridPoint.
        let centerX = Int32(portal.x) + Int32(portal.width) / 2
        let centerY = Int32(portal.y) + Int32(portal.height) / 2
        let center = GridPoint(x: Int16(clamping: centerX), y: Int16(clamping: centerY))
        if isWalkable(center) {
            return center
        }
        let step: Int32 = 8
        let maxX = Int32(portal.x) + Int32(portal.width)
        let maxY = Int32(portal.y) + Int32(portal.height)
        var best: GridPoint?
        var bestDistance = Int32.max
        var y = Int32(portal.y)
        while y < maxY {
            var x = Int32(portal.x)
            while x < maxX {
                let candidate = GridPoint(x: Int16(clamping: x), y: Int16(clamping: y))
                if isWalkable(candidate) {
                    let dx = x - centerX
                    let dy = y - centerY
                    let distance = dx * dx + dy * dy
                    if distance < bestDistance {
                        bestDistance = distance
                        best = candidate
                    }
                }
                x += step
            }
            y += step
        }
        return best ?? center
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
