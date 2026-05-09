import Foundation
import Logging
import SomnioCore
import SomnioProtocol

/// Per-player runtime slot in a sector. Mutated only inside `PerSectorActor`.
struct PlayerSlot {
    var entityIndex: Int16
    var character: Character
    var inventory: [InventoryRow]
    let outbox: ConnectionOutbox
}

/// Per-NPC runtime state. `position` is materialized via `NPCPlacement.runtimePosition`
/// at sector load time so the codec stays byte-faithful (sector definitions on disk are
/// unchanged, runtime centering happens here).
struct NPCRuntime {
    let entityIndex: Int16
    let definition: NPC
    var position: GridPoint
    var targetingEntity: Int16?
}

/// Per-monster-spawn runtime state. `attach` emits one Entity for each spawned monster
/// currently in the sector. The actual monster spawn cadence (timing/respawn) is handled
/// elsewhere; this layer mirrors the static `MonsterSpawn` so peers see authored monsters.
struct MonsterSpawnRuntime {
    let entityIndex: Int16
    let definition: MonsterSpawn
    var position: GridPoint
}

/// Snapshot of one player's persistent state, returned by `snapshotForCheckpoint` so the
/// shutdown drain and periodic checkpointer can write the full `Character` + `[InventoryRow]`
/// pair — every persistent field flows through, not just energy.
public struct PlayerCheckpoint: Sendable, Equatable {
    public var character: Character
    public var inventory: [InventoryRow]

    public init(character: Character, inventory: [InventoryRow]) {
        self.character = character
        self.inventory = inventory
    }
}

/// Result of an EquipToggle apply: the post-mutation row set for the originating connection
/// to re-emit as its own `inventory` snapshot.
public struct EquipApplyResult: Sendable, Equatable {
    public var inventory: [InventoryRow]

    public init(inventory: [InventoryRow]) {
        self.inventory = inventory
    }
}

/// Per-sector actor. Owns the sector's runtime player set, NPC + monster placement, and
/// the broadcast frame stream that funnels all peer-visible mutations through outboxes
/// without touching connection actors directly.
public actor PerSectorActor {
    public let staticSector: Sector
    private var players: [Int16: PlayerSlot] = [:]
    private var npcs: [Int16: NPCRuntime] = [:]
    private var monsters: [Int16: MonsterSpawnRuntime] = [:]
    /// Monotonic so peer indices remain stable for a given sector for the process lifetime.
    /// Index 0 is reserved for client-originated `clientPosition` (`PositionMessage.entityIndex == 0`),
    /// so allocation starts at 1.
    private var nextEntityIndex: Int16 = 1
    private let logger: Logger

    public init(staticSector: Sector, logger: Logger) {
        self.staticSector = staticSector
        self.logger = logger
        var nextIndex: Int16 = 1
        for npc in staticSector.npcs {
            let index = nextIndex
            npcs[index] = NPCRuntime(
                entityIndex: index,
                definition: npc,
                position: NPCPlacement.runtimePosition(for: npc),
                targetingEntity: nil
            )
            nextIndex = Self.advance(nextIndex)
        }
        for spawn in staticSector.monsterSpawns {
            let index = nextIndex
            monsters[index] = MonsterSpawnRuntime(
                entityIndex: index,
                definition: spawn,
                position: spawn.spawnOrigin
            )
            nextIndex = Self.advance(nextIndex)
        }
        self.nextEntityIndex = nextIndex
    }

    /// Increment with `&+=` and skip 0 — reserved for client-originated `clientPosition`
    /// (`PositionMessage.entityIndex`).
    private static func advance(_ index: Int16) -> Int16 {
        var next = index
        next &+= 1
        if next == 0 { next = 1 }
        return next
    }

    private func allocateEntityIndex() -> Int16 {
        let index = nextEntityIndex
        nextEntityIndex = Self.advance(nextEntityIndex)
        return index
    }

    /// Atomically allocate a slot for the new connection, stream the join sequence to the
    /// newcomer's outbox, and broadcast a single `entity` for the newcomer to existing peers.
    /// The returned `entityIndex` is what `WorldRouter`/`ConnectionActor` cache so subsequent
    /// position/say/equip frames can address the correct slot.
    public func attach(
        character: Character,
        inventory: [InventoryRow],
        outbox: ConnectionOutbox
    ) throws -> Int16 {
        let entityIndex = allocateEntityIndex()
        let slot = PlayerSlot(
            entityIndex: entityIndex,
            character: character,
            inventory: inventory,
            outbox: outbox
        )

        // Stream the newcomer's full join sequence first so the client sees the sector before
        // any peer entities.
        try outbox.send(SomnioMessageEncoder.encode(.enterSector(EnterSectorMessage(sector: staticSector.asWire))))
        try outbox.send(SomnioMessageEncoder.encode(.mainCharacter(MainCharacterMessage(entityIndex: entityIndex))))
        try outbox.send(SomnioMessageEncoder.encode(.inventory(InventoryMessage(rows: inventory.map(\.asWire)))))
        try outbox.send(SomnioMessageEncoder.encode(.energy(character.energy)))

        for peer in players.values {
            try outbox.send(SomnioMessageEncoder.encode(.entity(makeEntityMessage(for: peer))))
        }
        for npc in npcs.values {
            try outbox.send(SomnioMessageEncoder.encode(.entity(makeEntityMessage(for: npc))))
        }
        for monster in monsters.values {
            try outbox.send(SomnioMessageEncoder.encode(.entity(makeEntityMessage(for: monster))))
        }

        // Insert *after* streaming peers so the newcomer doesn't receive its own Entity.
        players[entityIndex] = slot
        let newcomerEntity = SomnioMessage.entity(makeEntityMessage(for: slot))
        try broadcastToPeers(newcomerEntity, excluding: entityIndex)
        return entityIndex
    }

    /// Remove the slot and broadcast a `leave` to remaining peer outboxes. `leftGame == true`
    /// means the player disconnected entirely; `false` means a sector switch.
    public func detach(entityIndex: Int16, leftGame: Bool) {
        guard players.removeValue(forKey: entityIndex) != nil else { return }
        do {
            try broadcastToPeers(.leave(LeaveMessage(entityIndex: entityIndex, leftGame: leftGame)), excluding: entityIndex)
        } catch {
            logger.warning("failed to broadcast leave", metadata: ["error": "\(error)", "entity_index": "\(entityIndex)"])
        }
    }

    /// Validate against sector bounds and collision masks; on success mutate the slot and
    /// broadcast the new position to peers. On failure drop silently — clients re-send.
    public func handlePosition(_ message: PositionMessage, from entityIndex: Int16) {
        guard var slot = players[entityIndex] else { return }
        let newPosition = GridPoint(x: message.x, y: message.y)
        guard isInside(newPosition, of: staticSector) else { return }
        guard !collides(newPosition, with: staticSector.collisionMasks) else { return }
        guard let facing = Direction(rawValue: message.facing), let tempo = Tempo(rawValue: message.tempo) else {
            return
        }
        slot.character.position = newPosition
        slot.character.facing = facing
        slot.character.tempo = tempo
        players[entityIndex] = slot
        let broadcast = PositionMessage(
            entityIndex: entityIndex,
            x: newPosition.x,
            y: newPosition.y,
            facing: facing.rawValue,
            tempo: tempo.rawValue
        )
        do {
            try broadcastToPeers(.serverPosition(broadcast), excluding: entityIndex)
        } catch {
            logger.warning("failed to broadcast position", metadata: ["error": "\(error)"])
        }
    }

    /// Re-broadcast a chat line to peers; the originating client renders its own bubble.
    public func handleSay(_ message: SayMessage, from entityIndex: Int16) {
        guard players[entityIndex] != nil else { return }
        do {
            try broadcastToPeers(
                .serverSay(SayMessage(entityIndex: entityIndex, text: message.text)),
                excluding: entityIndex
            )
        } catch {
            logger.warning("failed to broadcast say", metadata: ["error": "\(error)"])
        }
    }

    /// EquipToggle applies per-row equip state with an implicit unequip when another row
    /// already holds the same hand. Returns the post-mutation inventory so the caller can
    /// re-emit the snapshot to the originating connection's outbox; equip markers are per-player
    /// UI so we never broadcast.
    public func handleEquipToggle(slot: Int16, hand: WireHand, from entityIndex: Int16) -> EquipApplyResult? {
        guard var playerSlot = players[entityIndex] else { return nil }
        guard let rowIndex = playerSlot.inventory.firstIndex(where: { $0.slot == slot }) else { return nil }
        let coreHand: Hand? = switch hand {
        case .none: nil
        case .left: .left
        case .right: .right
        }
        if let coreHand {
            for index in playerSlot.inventory.indices where index != rowIndex && playerSlot.inventory[index].equippedHand == coreHand {
                playerSlot.inventory[index].equippedHand = nil
            }
        }
        playerSlot.inventory[rowIndex].equippedHand = coreHand
        players[entityIndex] = playerSlot
        return EquipApplyResult(inventory: playerSlot.inventory)
    }

    /// BumpNPC flips the targeting flag once — once an NPC is targeting a player, a second
    /// bump from another player is a no-op so the dialog isn't retargeted mid-script. The
    /// dialog-tick that walks the script cursor is implemented elsewhere; this only marks
    /// targeting.
    public func handleBumpNPC(npcIndex: Int16, from entityIndex: Int16) {
        guard players[entityIndex] != nil else { return }
        guard var npc = npcs[npcIndex] else { return }
        guard npc.targetingEntity == nil else { return }
        npc.targetingEntity = entityIndex
        npcs[npcIndex] = npc
    }

    /// Re-emit the player's current `serverPosition` to the originating connection so the
    /// client snaps back when an `enterPortal` resolves to an unknown destination
    /// (application-layer mismatch, not a wire-protocol violation).
    public func snapBack(entityIndex: Int16) {
        guard let slot = players[entityIndex] else { return }
        let message = PositionMessage(
            entityIndex: entityIndex,
            x: slot.character.position.x,
            y: slot.character.position.y,
            facing: slot.character.facing.rawValue,
            tempo: slot.character.tempo.rawValue
        )
        slot.outbox.sendEncoded(.serverPosition(message), logger: logger)
    }

    /// One snapshot per logged-in player for the periodic checkpointer + shutdown drain.
    /// Bumps each slot's `lastSeen` to `Date()` so `WorldRouter` can order this snapshot
    /// against any per-disconnect snapshot that races into the same character row.
    public func snapshotForCheckpoint() -> [PlayerCheckpoint] {
        let now = Date()
        var result: [PlayerCheckpoint] = []
        for (entityIndex, var slot) in players {
            slot.character.lastSeen = now
            players[entityIndex] = slot
            result.append(PlayerCheckpoint(character: slot.character, inventory: slot.inventory))
        }
        return result
    }

    /// Snapshot for a single player — used by the per-disconnect snapshot path so a normal
    /// close persists the latest position/inventory rather than relying on the next periodic
    /// checkpoint to catch up. Bumps `lastSeen` like `snapshotForCheckpoint` so the router
    /// can detect a mid-flight stale checkpoint.
    public func snapshotForPlayer(entityIndex: Int16) -> PlayerCheckpoint? {
        guard var slot = players[entityIndex] else { return nil }
        slot.character.lastSeen = Date()
        players[entityIndex] = slot
        return PlayerCheckpoint(character: slot.character, inventory: slot.inventory)
    }

    // MARK: - Helpers

    private func isInside(_ position: GridPoint, of sector: Sector) -> Bool {
        position.x >= 0 && position.y >= 0 && position.x < sector.dimensions.width && position.y < sector.dimensions.height
    }

    private func collides(_ position: GridPoint, with masks: [CollisionMask]) -> Bool {
        for mask in masks {
            if position.x >= mask.x, position.x < mask.x + mask.width,
               position.y >= mask.y, position.y < mask.y + mask.height {
                return true
            }
        }
        return false
    }

    private func broadcastToPeers(_ message: SomnioMessage, excluding entityIndex: Int16) throws {
        let frame = try SomnioMessageEncoder.encode(message)
        for (index, slot) in players where index != entityIndex {
            slot.outbox.send(frame)
        }
    }

    private func makeEntityMessage(for slot: PlayerSlot) -> EntityMessage {
        EntityMessage(
            entityIndex: slot.entityIndex,
            figure: slot.character.figure,
            gender: slot.character.gender.rawValue,
            maskWidth: SomnioConstants.tileSize,
            maskHeight: SomnioConstants.tileSize,
            type: .player,
            name: slot.character.name,
            x: slot.character.position.x,
            y: slot.character.position.y,
            facing: slot.character.facing.rawValue,
            tempo: slot.character.tempo.rawValue
        )
    }

    private func makeEntityMessage(for npc: NPCRuntime) -> EntityMessage {
        EntityMessage(
            entityIndex: npc.entityIndex,
            figure: npc.definition.figure,
            gender: 0,
            maskWidth: npc.definition.maskSize.width,
            maskHeight: npc.definition.maskSize.height,
            type: .npc,
            name: npc.definition.name,
            x: npc.position.x,
            y: npc.position.y,
            facing: npc.definition.direction,
            tempo: 0
        )
    }

    private func makeEntityMessage(for monster: MonsterSpawnRuntime) -> EntityMessage {
        EntityMessage(
            entityIndex: monster.entityIndex,
            figure: monster.definition.figure,
            gender: 0,
            maskWidth: monster.definition.spawnedMonsterSize.width,
            maskHeight: monster.definition.spawnedMonsterSize.height,
            type: .monster,
            name: monster.definition.name,
            x: monster.position.x,
            y: monster.position.y,
            facing: 0,
            tempo: 0
        )
    }
}

extension PlayerSlot: Equatable {
    static func == (lhs: PlayerSlot, rhs: PlayerSlot) -> Bool {
        lhs.entityIndex == rhs.entityIndex
    }
}
