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
/// unchanged, runtime centering happens here). `dialogSteps` caches the parsed script so
/// the AI tick does not allocate on every pass.
struct NPCRuntime {
    /// Cap that the per-tick dialog cooldown counter advances toward. Once reached, the next
    /// in-radius tick emits the current step; seeding to the cap at sector-actor init arms
    /// the first bump for an immediate emit.
    static let dialogCooldownCap: Int16 = 59

    let entityIndex: Int16
    let definition: NPC
    var position: GridPoint
    var targetingEntity: Int16?
    let dialogSteps: [String]
    var cooldownTicks: Int16
    /// 0-based cursor into `dialogSteps`. Persisted as 1-based; translated at the seam.
    var scriptStepIndex: Int16
}

/// Per-monster-spawn runtime state. `attach` emits one Entity for each spawned monster
/// currently in the sector. The actual monster spawn cadence (timing/respawn) is handled
/// elsewhere; this layer mirrors the static `MonsterSpawn` so peers see authored monsters.
struct MonsterSpawnRuntime {
    let entityIndex: Int16
    let definition: MonsterSpawn
    var position: GridPoint
    /// Live facing the AI tick rotates toward the chase target. Idle monsters render with
    /// the default so a join-sequence `entity` frame stays consistent with `runAITick()`.
    var facing: Direction = .south
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

/// One sector's per-tick AI digest. The actor returns this so the world router can dispatch
/// persistence outside the actor's isolation domain — actor mutations finish before the
/// repository calls land, so transient persistence failure cannot corrupt in-process state.
public struct AITickDigest: Sendable {
    public var dialogUpserts: [NPCDialogState]
    public var dialogResets: [NPCDialogResetKey]

    public init(dialogUpserts: [NPCDialogState] = [], dialogResets: [NPCDialogResetKey] = []) {
        self.dialogUpserts = dialogUpserts
        self.dialogResets = dialogResets
    }
}

/// Identifies the (sector, npc) row to delete from `npc_dialog_states`. Dialog reset persists
/// a row deletion, so the digest carries only the key — the full `NPCDialogState` would
/// imply the wrong write.
public struct NPCDialogResetKey: Sendable, Equatable {
    public let sectorName: String
    public let npcIndex: Int16

    public init(sectorName: String, npcIndex: Int16) {
        self.sectorName = sectorName
        self.npcIndex = npcIndex
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

    public init(
        staticSector: Sector,
        logger: Logger,
        initialDialogCursors: [Int16: Int16] = [:]
    ) {
        self.staticSector = staticSector
        self.logger = logger
        var nextIndex: Int16 = 1
        for npc in staticSector.npcs {
            let index = nextIndex
            let dialogSteps = npc.dialogSteps
            let scriptStepIndex = Self.resolveSeedStepIndex(
                persisted: initialDialogCursors[index],
                stepCount: dialogSteps.count,
                sectorName: staticSector.name,
                npcIndex: index,
                logger: logger
            )
            npcs[index] = NPCRuntime(
                entityIndex: index,
                definition: npc,
                position: NPCPlacement.runtimePosition(for: npc),
                targetingEntity: nil,
                dialogSteps: dialogSteps,
                cooldownTicks: NPCRuntime.dialogCooldownCap,
                scriptStepIndex: scriptStepIndex
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

    /// Translate a persisted 1-based `script_step` into the 0-based runtime cursor. Out-of-range
    /// values (zero, negative, missing-step, or beyond the parsed step count) clamp to `0` and
    /// log a warning so a script edit that shortens the step count is visible to operators
    /// rather than silently rewinding the cursor. The range check runs before the subtraction
    /// so a corrupt `Int16.min` cannot trap during boot.
    private static func resolveSeedStepIndex(
        persisted: Int16?,
        stepCount: Int,
        sectorName: String,
        npcIndex: Int16,
        logger: Logger
    ) -> Int16 {
        guard let persisted else { return 0 }
        if stepCount == 0 {
            if persisted != 1 {
                logger.warning(
                    "npc dialog cursor reset (script empty)",
                    metadata: [
                        "sector": "\(sectorName)",
                        "npc_index": "\(npcIndex)",
                        "persisted_step": "\(persisted)"
                    ]
                )
            }
            return 0
        }
        guard persisted >= 1, Int(persisted) <= stepCount else {
            logger.warning(
                "npc dialog cursor clamped (out of range)",
                metadata: [
                    "sector": "\(sectorName)",
                    "npc_index": "\(npcIndex)",
                    "persisted_step": "\(persisted)",
                    "step_count": "\(stepCount)"
                ]
            )
            return 0
        }
        return persisted - 1
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
    ///
    /// The proximity gate prevents an authenticated client from spamming `bumpNPC` for
    /// far-away NPCs to force per-call DB writes through the AI tick's out-of-radius reset
    /// path. Bumps that don't satisfy the dialog radius are dropped silently here, so the
    /// reset path only fires when an actually-bumped player walks away mid-script.
    public func handleBumpNPC(npcIndex: Int16, from entityIndex: Int16) {
        guard let player = players[entityIndex] else { return }
        guard var npc = npcs[npcIndex] else { return }
        guard npc.targetingEntity == nil else { return }
        let npcCenter = VisualCenter.center(position: npc.position, mask: npc.definition.maskSize)
        let playerCenter = VisualCenter.center(
            position: player.character.position,
            mask: GridSize(width: SomnioConstants.tileSize, height: SomnioConstants.tileSize)
        )
        guard VisualCenter.isWithin(npcCenter, playerCenter, radius: SomnioConstants.npcInteractionRadius) else {
            return
        }
        npc.targetingEntity = entityIndex
        npcs[npcIndex] = npc
    }

    /// One AI tick across the sector's NPCs and monsters. The deterministic mutator is the
    /// contracted test seam: `AITickService` calls this on a `Duration` cadence; tests drive
    /// it directly without sleeping. The returned `AITickDigest` flows out of actor isolation
    /// so the world router can persist dialog cursor changes through the repository without
    /// holding the actor.
    public func runAITick() -> AITickDigest {
        var digest = AITickDigest()
        runNPCTick(into: &digest)
        runMonsterTick()
        return digest
    }

    /// Walks every NPC and takes exactly one of the mutually exhaustive branches: idle
    /// cooldown advance, target-gone reset, out-of-radius reset, in-radius cooldown advance,
    /// or in-radius emit + cursor advance. The legacy `$name` token is substituted at emit
    /// time against the targeting player's character name.
    private func runNPCTick(into digest: inout AITickDigest) {
        for (index, npcSnapshot) in npcs {
            var npc = npcSnapshot
            guard let targetIndex = npc.targetingEntity else {
                // (a) idle: advance the cooldown so the next bump fires immediately.
                advanceCooldown(&npc)
                npcs[index] = npc
                continue
            }
            guard let targetSlot = players[targetIndex] else {
                // (b) target left the sector: reset cursor + clear targeting; persist a
                // delete so the in-process reset survives a restart.
                resetTargeting(&npc, into: &digest)
                npcs[index] = npc
                continue
            }
            let npcCenter = VisualCenter.center(position: npc.position, mask: npc.definition.maskSize)
            let targetCenter = VisualCenter.center(
                position: targetSlot.character.position,
                mask: GridSize(width: SomnioConstants.tileSize, height: SomnioConstants.tileSize)
            )
            guard VisualCenter.isWithin(npcCenter, targetCenter, radius: SomnioConstants.npcInteractionRadius) else {
                // (c) target walked out of radius: same reset as (b). The legacy server
                // resets both targeting and cursor when the target leaves the radius so one
                // player who walks away mid-script cannot lock the NPC for everyone else.
                resetTargeting(&npc, into: &digest)
                npcs[index] = npc
                continue
            }
            guard npc.cooldownTicks == NPCRuntime.dialogCooldownCap else {
                // (d) in-radius but pre-cooldown: advance toward the cap and skip emit.
                advanceCooldown(&npc)
                npcs[index] = npc
                continue
            }
            // (e) emit the current step, advance the cursor, wrap at the final line.
            guard !npc.dialogSteps.isEmpty else {
                // Empty script is a no-op: clear targeting so the next bump can re-arm.
                npc.targetingEntity = nil
                npcs[index] = npc
                continue
            }
            let step = npc.dialogSteps[Int(npc.scriptStepIndex)]
            let text = step.replacingOccurrences(of: "$name", with: targetSlot.character.name)
            do {
                try broadcastToAll(.serverSay(SayMessage(entityIndex: npc.entityIndex, text: text)))
            } catch {
                logger.warning(
                    "failed to broadcast npc dialog",
                    metadata: ["error": "\(error)", "npc_index": "\(npc.entityIndex)"]
                )
            }
            npc.cooldownTicks = 0
            let nextIndex = npc.scriptStepIndex + 1
            if nextIndex >= Int16(npc.dialogSteps.count) {
                npc.scriptStepIndex = 0
                npc.targetingEntity = nil
                digest.dialogResets.append(
                    NPCDialogResetKey(sectorName: staticSector.name, npcIndex: npc.entityIndex)
                )
            } else {
                npc.scriptStepIndex = nextIndex
                digest.dialogUpserts.append(
                    NPCDialogState(
                        sectorName: staticSector.name,
                        npcIndex: npc.entityIndex,
                        scriptStep: nextIndex + 1
                    )
                )
            }
            npcs[index] = npc
        }
    }

    /// Advance an NPC's cooldown toward `NPCRuntime.dialogCooldownCap`. Pulled out so every
    /// non-emit branch (idle, target-gone, out-of-radius, in-radius pre-cooldown) shares
    /// one definition of "cooldown progresses while the next emit is still pending."
    private func advanceCooldown(_ npc: inout NPCRuntime) {
        if npc.cooldownTicks < NPCRuntime.dialogCooldownCap {
            npc.cooldownTicks += 1
        }
    }

    /// Clear targeting + reset the cursor + advance cooldown + record a reset key on the
    /// digest. Both the target-left-sector and out-of-radius branches use this shape.
    private func resetTargeting(_ npc: inout NPCRuntime, into digest: inout AITickDigest) {
        npc.targetingEntity = nil
        npc.scriptStepIndex = 0
        advanceCooldown(&npc)
        digest.dialogResets.append(
            NPCDialogResetKey(sectorName: staticSector.name, npcIndex: npc.entityIndex)
        )
    }

    /// Branch-0 monsters orient + chase the nearest in-aggro player. Other AI scripts idle
    /// (no broadcast, no mutation). Combat hooks intentionally absent — no damage, death,
    /// drop, or respawn yet; this is the single integration surface for a future combat
    /// extension so future readers find one place to wire the new behavior in.
    private func runMonsterTick() {
        for (index, monsterSnapshot) in monsters {
            guard monsterSnapshot.definition.aiScriptIndex == 0 else { continue }
            var monster = monsterSnapshot
            let monsterCenter = VisualCenter.center(
                position: monster.position,
                mask: monster.definition.spawnedMonsterSize
            )
            let playerMask = GridSize(width: SomnioConstants.tileSize, height: SomnioConstants.tileSize)
            let aggroRadius = Int64(SomnioConstants.monsterAggroRadius)
            let aggroRadiusSquared = aggroRadius * aggroRadius
            // The chase only needs the closest-target's center, so the running candidate
            // tracks `(center, squared)` rather than the full `PlayerSlot`. The single
            // `squaredDistance` per candidate doubles as the aggro-radius gate to avoid
            // recomputing the distance twice.
            var closest: (center: (x: Int32, y: Int32), squared: Int64)?
            for slot in players.values {
                let candidateCenter = VisualCenter.center(position: slot.character.position, mask: playerMask)
                let squared = VisualCenter.squaredDistance(monsterCenter, candidateCenter)
                guard squared <= aggroRadiusSquared else { continue }
                if let existing = closest, squared >= existing.squared { continue }
                closest = (candidateCenter, squared)
            }
            guard let target = closest else { continue }
            let dx = target.center.x - monsterCenter.x
            let dy = target.center.y - monsterCenter.y
            // Dominant-axis facing with a horizontal tie-break at exact 45 degrees so the
            // chase orientation matches the legacy quadrant function for every (dx, dy).
            let facing: Direction = if abs(dx) >= abs(dy) {
                dx > 0 ? .east : .west
            } else {
                dy > 0 ? .south : .north
            }
            monster.facing = facing
            // Chase step: 6 px Euclidean per tick once the Manhattan gate clears. On a 45°
            // diagonal this yields ≈(4, 4); Manhattan-based scaling would yield (3, 3),
            // visibly slower.
            let manhattan = abs(dx) + abs(dy)
            let stepDx: Int32
            let stepDy: Int32
            if manhattan >= 6 {
                let length = (Double(dx) * Double(dx) + Double(dy) * Double(dy)).squareRoot()
                stepDx = Int32((Double(dx) * 6.0 / length).rounded())
                stepDy = Int32((Double(dy) * 6.0 / length).rounded())
            } else {
                stepDx = dx
                stepDy = dy
            }
            // Clamp into `Int16` so a monster near a near-`Int16.max` sector edge cannot
            // trap on the position add. The subsequent `isInside` gate keeps in-bounds
            // semantics intact for the runtime position.
            let proposed = GridPoint(
                x: Int16(clamping: Int32(monster.position.x) + stepDx),
                y: Int16(clamping: Int32(monster.position.y) + stepDy)
            )
            if isInside(proposed, of: staticSector), !collides(proposed, with: staticSector.collisionMasks) {
                monster.position = proposed
            }
            monsters[index] = monster
            do {
                try broadcastToAll(
                    .serverPosition(
                        PositionMessage(
                            entityIndex: monster.entityIndex,
                            x: monster.position.x,
                            y: monster.position.y,
                            facing: monster.facing.rawValue,
                            tempo: Tempo.default.rawValue
                        )
                    )
                )
            } catch {
                logger.warning(
                    "failed to broadcast monster position",
                    metadata: ["error": "\(error)", "monster_index": "\(monster.entityIndex)"]
                )
            }
        }
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
        // Mask endpoints (`x + width`, `y + height`) widen to `Int32` for the same reason
        // `VisualCenter` uses wider arithmetic: a corrupt sector with an authored mask near
        // `Int16.max` cannot be allowed to trap the AI tick on the bounds check.
        let positionX = Int32(position.x)
        let positionY = Int32(position.y)
        for mask in masks {
            let maskX = Int32(mask.x)
            let maskY = Int32(mask.y)
            let maskRight = maskX + Int32(mask.width)
            let maskBottom = maskY + Int32(mask.height)
            if positionX >= maskX, positionX < maskRight,
               positionY >= maskY, positionY < maskBottom {
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

    /// Encode once and fan out to every slot's outbox. Used by the AI tick where a monster
    /// reorientation or NPC dialog line should reach every player in the sector — including
    /// the one whose proximity caused the broadcast.
    private func broadcastToAll(_ message: SomnioMessage) throws {
        let frame = try SomnioMessageEncoder.encode(message)
        for slot in players.values {
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
            facing: monster.facing.rawValue,
            tempo: 0
        )
    }
}

extension PlayerSlot: Equatable {
    static func == (lhs: PlayerSlot, rhs: PlayerSlot) -> Bool {
        lhs.entityIndex == rhs.entityIndex
    }
}
