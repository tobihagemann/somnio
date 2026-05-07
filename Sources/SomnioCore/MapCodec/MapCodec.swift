import Foundation

public enum MapCodecError: Error, Equatable, Sendable {
    case truncated
    case truncatedRecord(typeID: Int)
    case unknownRecordType(Int)
    case unsupportedDiscriminator(Int)
    case unknownPortalDirection(Int)
    case invalidPString(at: Int)
    case trailingBytesInRecord(typeID: Int, remaining: Int)
}

/// Bidirectional codec for the original record-type sector binary format.
///
/// The reader is **byte-faithful**: it stores the file's authored `spawnOrigin` verbatim
/// and never applies runtime placement adjustments. NPC centering lives in
/// `NPCPlacement.runtimePosition(for:)` and is computed at spawn time, not at file-load
/// time.
///
/// The writer canonicalizes record ordering: version → sector header → objects → collision
/// masks → portals → NPCs → monster spawns. Round-trip acceptance is **semantic** (read →
/// write → read matches the original parsed `Sector`), not byte-identity. The writer also
/// does **not** reproduce the original's off-by-one `MonsterSpawn.balance` bug.
public enum MapCodec {
    private enum RecordType: Int {
        case version = 0
        case sectorHeader = 1
        case object = 2
        case collisionMask = 3
        case sectorPortal = 4
        case npcOrMonsterSpawn = 5
    }

    public static func read(_ data: Data) throws -> SectorBody {
        var reader = BinaryReader(data)

        var version: Int16 = 0
        var dimensions = GridSize(width: 0, height: 0)
        var ground = GroundTile(tilesetIndex: 0, sourceX: 0, sourceY: 0)
        var light = LightSetting(indoor: false, brightness: 0)
        var objects: [Object] = []
        var collisionMasks: [CollisionMask] = []
        var portals: [SectorPortal] = []
        var npcs: [NPC] = []
        var monsterSpawns: [MonsterSpawn] = []

        while !reader.isAtEnd {
            let length = try Int(reader.readUInt16LE())
            guard length >= 2 else {
                throw MapCodecError.truncated
            }
            let recordTypeRaw = try Int(reader.readUInt16LE())
            let payloadSize = length - 2
            guard reader.offset + payloadSize <= reader.data.count else {
                throw MapCodecError.truncatedRecord(typeID: recordTypeRaw)
            }
            let payloadBytes = try reader.readBytes(payloadSize)

            guard let recordType = RecordType(rawValue: recordTypeRaw) else {
                throw MapCodecError.unknownRecordType(recordTypeRaw)
            }

            var payload = BinaryReader(payloadBytes)
            try readRecord(recordType, &payload, &version, &dimensions, &ground, &light,
                           &objects, &collisionMasks, &portals, &npcs, &monsterSpawns)
            guard payload.isAtEnd else {
                throw MapCodecError.trailingBytesInRecord(
                    typeID: recordType.rawValue,
                    remaining: payload.data.count - payload.offset
                )
            }
        }

        return SectorBody(
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

    // swiftlint:disable:next function_body_length function_parameter_count
    private static func readRecord(
        _ recordType: RecordType,
        _ payload: inout BinaryReader,
        _ version: inout Int16,
        _ dimensions: inout GridSize,
        _ ground: inout GroundTile,
        _ light: inout LightSetting,
        _ objects: inout [Object],
        _ collisionMasks: inout [CollisionMask],
        _ portals: inout [SectorPortal],
        _ npcs: inout [NPC],
        _ monsterSpawns: inout [MonsterSpawn]
    ) throws {
        switch recordType {
        case .version:
            version = try payload.readInt16LE()

        case .sectorHeader:
            let w = try payload.readInt16LE()
            let h = try payload.readInt16LE()
            let tilesetIndex = try payload.readInt16LE()
            let sourceX = try payload.readInt16LE()
            let sourceY = try payload.readInt16LE()
            let indoorFlag = try payload.readInt16LE()
            let brightness = try payload.readInt16LE()
            dimensions = GridSize(width: w, height: h)
            ground = GroundTile(tilesetIndex: tilesetIndex, sourceX: sourceX, sourceY: sourceY)
            light = LightSetting(indoor: indoorFlag != 0, brightness: brightness)

        case .object:
            try objects.append(Object(
                x: payload.readInt16LE(),
                y: payload.readInt16LE(),
                tilesetIndex: payload.readInt16LE(),
                sourceX: payload.readInt16LE(),
                sourceY: payload.readInt16LE(),
                sourceWidth: payload.readInt16LE(),
                sourceHeight: payload.readInt16LE(),
                priority: payload.readInt16LE()
            ))

        case .collisionMask:
            try collisionMasks.append(CollisionMask(
                x: payload.readInt16LE(),
                y: payload.readInt16LE(),
                width: payload.readInt16LE(),
                height: payload.readInt16LE()
            ))

        case .sectorPortal:
            let x = try payload.readInt16LE()
            let y = try payload.readInt16LE()
            let width = try payload.readInt16LE()
            let height = try payload.readInt16LE()
            let target = try PString.read(&payload, recordTypeID: recordType.rawValue)
            let directionRaw = try payload.readInt16LE()
            guard let direction = PortalDirection(rawValue: directionRaw) else {
                throw MapCodecError.unknownPortalDirection(Int(directionRaw))
            }
            portals.append(SectorPortal(
                x: x, y: y, width: width, height: height,
                targetSectorName: target, direction: direction
            ))

        case .npcOrMonsterSpawn:
            let spawnX = try payload.readInt16LE()
            let spawnY = try payload.readInt16LE()
            let spawnBoxW = try payload.readInt16LE()
            let spawnBoxH = try payload.readInt16LE()
            let maskW = try payload.readInt16LE()
            let maskH = try payload.readInt16LE()
            let discriminator = try payload.readInt16LE()
            let name = try PString.read(&payload, recordTypeID: recordType.rawValue)

            switch discriminator {
            case 0:
                try npcs.append(NPC(
                    spawnOrigin: GridPoint(x: spawnX, y: spawnY),
                    spawnBoxSize: GridSize(width: spawnBoxW, height: spawnBoxH),
                    maskSize: GridSize(width: maskW, height: maskH),
                    name: name,
                    figure: payload.readInt16LE(),
                    direction: payload.readInt16LE(),
                    behaviorTag: payload.readInt16LE(),
                    dialogScript: PString.read(&payload, recordTypeID: recordType.rawValue)
                ))
            case 1:
                try monsterSpawns.append(MonsterSpawn(
                    spawnOrigin: GridPoint(x: spawnX, y: spawnY),
                    spawnBoxSize: GridSize(width: spawnBoxW, height: spawnBoxH),
                    spawnedMonsterSize: GridSize(width: maskW, height: maskH),
                    name: name,
                    figure: payload.readInt16LE(),
                    bounded: payload.readInt16LE() != 0,
                    spawnHP: payload.readInt16LE(),
                    spawnBalance: payload.readInt16LE(),
                    spawnMana: payload.readInt16LE(),
                    aiScriptIndex: payload.readInt16LE()
                ))
            default:
                throw MapCodecError.unsupportedDiscriminator(Int(discriminator))
            }
        }
    }

    // swiftlint:disable:next function_body_length
    public static func write(_ sector: SectorBody) throws -> Data {
        var out = BinaryWriter()

        try emitRecord(into: &out, type: .version) { payload in
            payload.writeInt16LE(sector.version)
        }

        try emitRecord(into: &out, type: .sectorHeader) { payload in
            payload.writeInt16LE(sector.dimensions.width)
            payload.writeInt16LE(sector.dimensions.height)
            payload.writeInt16LE(sector.ground.tilesetIndex)
            payload.writeInt16LE(sector.ground.sourceX)
            payload.writeInt16LE(sector.ground.sourceY)
            payload.writeInt16LE(sector.light.indoor ? 1 : 0)
            payload.writeInt16LE(sector.light.brightness)
        }

        for o in sector.objects {
            try emitRecord(into: &out, type: .object) { payload in
                payload.writeInt16LE(o.x)
                payload.writeInt16LE(o.y)
                payload.writeInt16LE(o.tilesetIndex)
                payload.writeInt16LE(o.sourceX)
                payload.writeInt16LE(o.sourceY)
                payload.writeInt16LE(o.sourceWidth)
                payload.writeInt16LE(o.sourceHeight)
                payload.writeInt16LE(o.priority)
            }
        }

        for m in sector.collisionMasks {
            try emitRecord(into: &out, type: .collisionMask) { payload in
                payload.writeInt16LE(m.x)
                payload.writeInt16LE(m.y)
                payload.writeInt16LE(m.width)
                payload.writeInt16LE(m.height)
            }
        }

        for p in sector.portals {
            try emitRecord(into: &out, type: .sectorPortal) { payload in
                payload.writeInt16LE(p.x)
                payload.writeInt16LE(p.y)
                payload.writeInt16LE(p.width)
                payload.writeInt16LE(p.height)
                try PString.write(&payload, p.targetSectorName)
                payload.writeInt16LE(p.direction.rawValue)
            }
        }

        for n in sector.npcs {
            try emitRecord(into: &out, type: .npcOrMonsterSpawn) { payload in
                payload.writeInt16LE(n.spawnOrigin.x)
                payload.writeInt16LE(n.spawnOrigin.y)
                payload.writeInt16LE(n.spawnBoxSize.width)
                payload.writeInt16LE(n.spawnBoxSize.height)
                payload.writeInt16LE(n.maskSize.width)
                payload.writeInt16LE(n.maskSize.height)
                payload.writeInt16LE(0) // discriminator: NPC
                try PString.write(&payload, n.name)
                payload.writeInt16LE(n.figure)
                payload.writeInt16LE(n.direction)
                payload.writeInt16LE(n.behaviorTag)
                try PString.write(&payload, n.dialogScript)
            }
        }

        for s in sector.monsterSpawns {
            try emitRecord(into: &out, type: .npcOrMonsterSpawn) { payload in
                payload.writeInt16LE(s.spawnOrigin.x)
                payload.writeInt16LE(s.spawnOrigin.y)
                payload.writeInt16LE(s.spawnBoxSize.width)
                payload.writeInt16LE(s.spawnBoxSize.height)
                payload.writeInt16LE(s.spawnedMonsterSize.width)
                payload.writeInt16LE(s.spawnedMonsterSize.height)
                payload.writeInt16LE(1) // discriminator: MonsterSpawn
                try PString.write(&payload, s.name)
                payload.writeInt16LE(s.figure)
                payload.writeInt16LE(s.bounded ? 1 : 0)
                payload.writeInt16LE(s.spawnHP)
                payload.writeInt16LE(s.spawnBalance)
                payload.writeInt16LE(s.spawnMana)
                payload.writeInt16LE(s.aiScriptIndex)
            }
        }

        return out.data
    }

    private static func emitRecord(
        into out: inout BinaryWriter,
        type: RecordType,
        body: (inout BinaryWriter) throws -> Void
    ) throws {
        var payload = BinaryWriter()
        try body(&payload)
        let length = 2 + payload.data.count
        out.writeUInt16LE(UInt16(length))
        out.writeUInt16LE(UInt16(type.rawValue))
        out.writeBytes(payload.data)
    }
}
