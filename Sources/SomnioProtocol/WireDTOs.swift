import Foundation

// Wire DTOs that mirror geometry / sector shapes in SomnioCore. They live here so that
// `EnterSectorMessage` can carry a sector definition without SomnioProtocol importing
// SomnioCore — the module boundary forbids it. SomnioCore provides bidirectional
// conversion (`SomnioCore/Wire/WireConversions.swift`) where it can name both shapes.

public struct WireGridPoint: Codable, Sendable, Equatable, Hashable {
    public var x: Int16
    public var y: Int16

    public init(x: Int16, y: Int16) {
        self.x = x
        self.y = y
    }

    public enum CodingKeys: String, CaseIterable, CodingKey { case x; case y }
}

public struct WireGridSize: Codable, Sendable, Equatable, Hashable {
    public var width: Int16
    public var height: Int16

    public init(width: Int16, height: Int16) {
        self.width = width
        self.height = height
    }

    public enum CodingKeys: String, CaseIterable, CodingKey { case width; case height }
}

public struct WireGroundTile: Codable, Sendable, Equatable, Hashable {
    public var tilesetIndex: Int16
    public var sourceX: Int16
    public var sourceY: Int16

    public init(tilesetIndex: Int16, sourceX: Int16, sourceY: Int16) {
        self.tilesetIndex = tilesetIndex
        self.sourceX = sourceX
        self.sourceY = sourceY
    }

    public enum CodingKeys: String, CaseIterable, CodingKey { case tilesetIndex; case sourceX; case sourceY }
}

public struct WireLightSetting: Codable, Sendable, Equatable, Hashable {
    public var indoor: Bool
    public var brightness: Int16

    public init(indoor: Bool, brightness: Int16) {
        self.indoor = indoor
        self.brightness = brightness
    }

    public enum CodingKeys: String, CaseIterable, CodingKey { case indoor; case brightness }
}

public struct WireObject: Codable, Sendable, Equatable, Hashable {
    public var x: Int16
    public var y: Int16
    public var tilesetIndex: Int16
    public var sourceX: Int16
    public var sourceY: Int16
    public var sourceWidth: Int16
    public var sourceHeight: Int16
    public var priority: Int16

    public init(
        x: Int16,
        y: Int16,
        tilesetIndex: Int16,
        sourceX: Int16,
        sourceY: Int16,
        sourceWidth: Int16,
        sourceHeight: Int16,
        priority: Int16
    ) {
        self.x = x
        self.y = y
        self.tilesetIndex = tilesetIndex
        self.sourceX = sourceX
        self.sourceY = sourceY
        self.sourceWidth = sourceWidth
        self.sourceHeight = sourceHeight
        self.priority = priority
    }

    public enum CodingKeys: String, CaseIterable, CodingKey {
        case x; case y; case tilesetIndex; case sourceX; case sourceY
        case sourceWidth; case sourceHeight; case priority
    }
}

public struct WireCollisionMask: Codable, Sendable, Equatable, Hashable {
    public var x: Int16
    public var y: Int16
    public var width: Int16
    public var height: Int16

    public init(x: Int16, y: Int16, width: Int16, height: Int16) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public enum CodingKeys: String, CaseIterable, CodingKey { case x; case y; case width; case height }
}

public struct WireSectorPortal: Codable, Sendable, Equatable, Hashable {
    public var x: Int16
    public var y: Int16
    public var width: Int16
    public var height: Int16
    public var targetSectorName: String
    public var direction: Int16

    public init(
        x: Int16,
        y: Int16,
        width: Int16,
        height: Int16,
        targetSectorName: String,
        direction: Int16
    ) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.targetSectorName = targetSectorName
        self.direction = direction
    }

    public enum CodingKeys: String, CaseIterable, CodingKey {
        case x; case y; case width; case height; case targetSectorName; case direction
    }
}

public struct WireNPC: Codable, Sendable, Equatable, Hashable {
    public var spawnX: Int16
    public var spawnY: Int16
    public var spawnBoxWidth: Int16
    public var spawnBoxHeight: Int16
    public var maskWidth: Int16
    public var maskHeight: Int16
    public var name: String
    public var figure: Int16
    public var direction: Int16
    public var behaviorTag: Int16
    public var dialogScript: String

    public init(
        spawnX: Int16,
        spawnY: Int16,
        spawnBoxWidth: Int16,
        spawnBoxHeight: Int16,
        maskWidth: Int16,
        maskHeight: Int16,
        name: String,
        figure: Int16,
        direction: Int16,
        behaviorTag: Int16,
        dialogScript: String
    ) {
        self.spawnX = spawnX
        self.spawnY = spawnY
        self.spawnBoxWidth = spawnBoxWidth
        self.spawnBoxHeight = spawnBoxHeight
        self.maskWidth = maskWidth
        self.maskHeight = maskHeight
        self.name = name
        self.figure = figure
        self.direction = direction
        self.behaviorTag = behaviorTag
        self.dialogScript = dialogScript
    }

    public enum CodingKeys: String, CaseIterable, CodingKey {
        case spawnX; case spawnY; case spawnBoxWidth; case spawnBoxHeight
        case maskWidth; case maskHeight; case name; case figure; case direction
        case behaviorTag; case dialogScript
    }
}

public struct WireMonsterSpawn: Codable, Sendable, Equatable, Hashable {
    public var spawnX: Int16
    public var spawnY: Int16
    public var spawnBoxWidth: Int16
    public var spawnBoxHeight: Int16
    public var monsterWidth: Int16
    public var monsterHeight: Int16
    public var name: String
    public var figure: Int16
    public var bounded: Bool
    public var spawnHP: Int16
    public var spawnBalance: Int16
    public var spawnMana: Int16
    public var aiScriptIndex: Int16

    public init(
        spawnX: Int16,
        spawnY: Int16,
        spawnBoxWidth: Int16,
        spawnBoxHeight: Int16,
        monsterWidth: Int16,
        monsterHeight: Int16,
        name: String,
        figure: Int16,
        bounded: Bool,
        spawnHP: Int16,
        spawnBalance: Int16,
        spawnMana: Int16,
        aiScriptIndex: Int16
    ) {
        self.spawnX = spawnX
        self.spawnY = spawnY
        self.spawnBoxWidth = spawnBoxWidth
        self.spawnBoxHeight = spawnBoxHeight
        self.monsterWidth = monsterWidth
        self.monsterHeight = monsterHeight
        self.name = name
        self.figure = figure
        self.bounded = bounded
        self.spawnHP = spawnHP
        self.spawnBalance = spawnBalance
        self.spawnMana = spawnMana
        self.aiScriptIndex = aiScriptIndex
    }

    public enum CodingKeys: String, CaseIterable, CodingKey {
        case spawnX; case spawnY; case spawnBoxWidth; case spawnBoxHeight
        case monsterWidth; case monsterHeight; case name; case figure; case bounded
        case spawnHP; case spawnBalance; case spawnMana; case aiScriptIndex
    }
}

public struct WireSector: Codable, Sendable, Equatable, Hashable {
    public var name: String
    public var version: Int16
    public var dimensions: WireGridSize
    public var ground: WireGroundTile
    public var light: WireLightSetting
    public var objects: [WireObject]
    public var collisionMasks: [WireCollisionMask]
    public var portals: [WireSectorPortal]
    public var npcs: [WireNPC]
    public var monsterSpawns: [WireMonsterSpawn]

    public init(
        name: String,
        version: Int16,
        dimensions: WireGridSize,
        ground: WireGroundTile,
        light: WireLightSetting,
        objects: [WireObject],
        collisionMasks: [WireCollisionMask],
        portals: [WireSectorPortal],
        npcs: [WireNPC],
        monsterSpawns: [WireMonsterSpawn]
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

    public enum CodingKeys: String, CaseIterable, CodingKey {
        case name; case version; case dimensions; case ground; case light
        case objects; case collisionMasks; case portals; case npcs; case monsterSpawns
    }
}

public struct WireInventoryExtra: Codable, Sendable, Equatable, Hashable {
    public var key: String
    public var value: Int16

    public init(key: String, value: Int16) {
        self.key = key
        self.value = value
    }

    public enum CodingKeys: String, CaseIterable, CodingKey { case key; case value }
}

public enum WireHand: Int16, Codable, Sendable, Equatable, Hashable, CaseIterable {
    case none = 0
    case left = 1
    case right = 2
}

public struct WireInventoryRow: Codable, Sendable, Equatable, Hashable {
    public var slot: Int16
    public var category: Int16
    public var itemId: Int16
    public var extras: [WireInventoryExtra]
    public var equippedHand: WireHand

    public init(
        slot: Int16,
        category: Int16,
        itemId: Int16,
        extras: [WireInventoryExtra],
        equippedHand: WireHand
    ) {
        self.slot = slot
        self.category = category
        self.itemId = itemId
        self.extras = extras
        self.equippedHand = equippedHand
    }

    public enum CodingKeys: String, CaseIterable, CodingKey {
        case slot; case category; case itemId; case extras; case equippedHand
    }
}
