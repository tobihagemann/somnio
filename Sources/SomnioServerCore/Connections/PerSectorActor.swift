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
/// at sector load time so the codec stays placement-agnostic (the authored `spawnOrigin`
/// on disk is unchanged, runtime centering happens here). `dialogSteps` caches the parsed
/// script so the AI tick does not allocate on every pass.
struct NPCRuntime {
    /// Cap that the per-tick dialog cooldown counter advances toward. Once reached, the next
    /// in-radius tick emits the current step; seeding to the cap at sector-actor init arms
    /// the first bump for an immediate emit.
    ///
    /// Derived from one source of truth — `npcDialogCooldownSeconds / defaultAITickIntervalSeconds`
    /// ticks per cooldown — minus one, because the counter starts at 0 and the emit gate is `==`,
    /// so readiness lands one tick early. The `Int16(...)` truncation is intentional.
    static let dialogCooldownCap = Int16(SomnioConstants.npcDialogCooldownSeconds / AITickService.defaultAITickIntervalSeconds) - 1

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
/// currently in the sector. Live monsters are materialized lazily by the spawn cadence
/// (`MonsterSpawnTimer`), not at sector-actor init.
struct MonsterSpawnRuntime {
    let entityIndex: Int16
    let definition: MonsterSpawn
    var position: GridPoint
    /// Live facing the AI tick rotates toward the chase target. Idle monsters render with
    /// the default so a join-sequence `entity` frame stays consistent with `runAITick()`.
    var facing: Direction = .south
}

/// Per-`MonsterSpawn` spawn cadence state. Each AI tick advances `cooldownTicks` toward the
/// spawn threshold while the sector is below the live-monster cap; at the threshold a live
/// monster materializes and the counter resets. Seeded to 0 so the first spawn fires after
/// ~60 s (the threshold of ticks), not at boot.
struct MonsterSpawnTimer {
    let definition: MonsterSpawn
    var cooldownTicks: Int16 = 0
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
    /// Tick count a spawn timer advances to before materializing a live monster — ~60 s at the
    /// 50 ms AI-tick cadence (1199 ticks → first spawn on tick 1200). Injectable so tests don't
    /// run the full cadence; the default is the faithful value.
    public static let defaultMonsterSpawnThreshold: Int16 = 1199
    /// Random placement retry cap for arrival/spawn before falling back.
    private static let placementAttempts = 64
    /// Observe-only movement-anomaly thresholds. A move is flagged (logged, never rejected) when it
    /// covers more ground than running speed × elapsed × tolerance + a flat slack — the only
    /// exploitable case being an accepted teleport. See `handlePosition` / `instrumentAcceptedMove`.
    private static let movementAnomalyToleranceFactor = 2.0
    private static let movementAnomalyFlatSlackPixels = Double(SomnioConstants.tileSize)
    /// Floor on the elapsed interval so a near-zero gap between rapid messages can't shrink the
    /// reference cap to nothing and flag a legitimate move.
    private static let movementAnomalyMinElapsedSeconds = AITickService.defaultAITickIntervalSeconds
    /// Minimum gap between anomaly log lines per entity; anomalies in between are coalesced into the
    /// next line's `suppressed_since_last` count, bounding log output under deliberate teleport spam.
    private static let movementAnomalyLogIntervalSeconds = 5.0

    public let staticSector: Sector
    private var players: [Int16: PlayerSlot] = [:]
    private var npcs: [Int16: NPCRuntime] = [:]
    private var monsters: [Int16: MonsterSpawnRuntime] = [:]
    /// One per authored `MonsterSpawn`; advanced by the AI tick to drive the spawn cadence.
    private var spawnTimers: [MonsterSpawnTimer] = []
    /// Random source for arrival/spawn placement. Injectable so tests can seed it for
    /// deterministic placement; defaults to the system generator in production.
    private var rng: any RandomNumberGenerator
    private let monsterSpawnThreshold: Int16
    /// Monotonic so peer indices remain stable for a given sector for the process lifetime.
    /// Index 0 is reserved for client-originated `clientPosition` (`PositionMessage.entityIndex == 0`),
    /// so allocation starts at 1.
    private var nextEntityIndex: Int16 = 1
    private let logger: Logger
    /// Anomaly records route here so they land in `gameplay-log.log` (the label-filtered backend).
    private let movementLogger = Logger(label: "de.tobiha.somnio.server.gameplay.movement")
    /// Per-entity baseline for the movement-anomaly verdict: the timestamp of the last accepted move.
    /// Set on attach and on every accepted move, removed on detach so it can't grow across churn.
    private var lastAcceptedMoveAt: [Int16: ContinuousClock.Instant] = [:]
    /// Per-entity rate-limit/coalesce state for the anomaly log, removed on detach.
    private var anomalyLogState: [Int16: (lastLoggedAt: ContinuousClock.Instant, suppressedCount: Int)] = [:]

    public init(
        staticSector: Sector,
        logger: Logger,
        initialDialogCursors: [Int16: Int16] = [:],
        rng: any RandomNumberGenerator = SystemRandomNumberGenerator(),
        monsterSpawnThreshold: Int16 = PerSectorActor.defaultMonsterSpawnThreshold
    ) {
        self.staticSector = staticSector
        self.logger = logger
        self.rng = rng
        self.monsterSpawnThreshold = monsterSpawnThreshold
        self.spawnTimers = staticSector.monsterSpawns.map { MonsterSpawnTimer(definition: $0) }
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
        // Monsters are not materialized here — the spawn cadence (`runMonsterSpawns`) creates them
        // at runtime and allocates their indices then, so `nextEntityIndex` advances past the NPCs.
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

    /// First free index at or after `start`, probing the full nonzero `Int16` domain via `advance`
    /// (so `Int16.max` wraps to `Int16.min`, not 1 — negative indices are wire-valid). Returns `nil`
    /// when every candidate is occupied: handing back an occupied index would overwrite a live slot's
    /// broadcast routing, the exact silent-corruption this probe exists to prevent. Pure function of
    /// `start` + the predicate so it is unit-testable without the actor.
    static func nextFreeIndex(startingAt start: Int16, isOccupied: (Int16) -> Bool) -> Int16? {
        var candidate = start
        for _ in 0 ..< Int(UInt16.max) {
            if !isOccupied(candidate) { return candidate }
            candidate = advance(candidate)
        }
        return nil
    }

    /// Allocate the next free entity index, probing live slots so a wrapped cursor never overwrites a
    /// still-live entity. Returns `nil` only when the full nonzero `Int16` domain is occupied —
    /// impossible under the per-sector entity caps but defended so exhaustion surfaces as an operator
    /// log rather than a silent overwrite. Callers handle `nil` per their own contract.
    private func allocateEntityIndex() -> Int16? {
        guard let index = Self.nextFreeIndex(
            startingAt: nextEntityIndex,
            isOccupied: { players[$0] != nil || npcs[$0] != nil || monsters[$0] != nil }
        ) else {
            logger.error("sector full — entity-index space exhausted", metadata: ["sector": "\(staticSector.name)"])
            return nil
        }
        nextEntityIndex = Self.advance(index)
        return index
    }

    /// Thrown by `attach` when the sector's entity-index space is exhausted — impossible under the
    /// per-sector entity caps, surfaced so a thrown error aborts the join cleanly rather than reusing
    /// a live index.
    enum AttachError: Error {
        case sectorFull
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
        guard let entityIndex = allocateEntityIndex() else { throw AttachError.sectorFull }
        let slot = PlayerSlot(
            entityIndex: entityIndex,
            character: character,
            inventory: inventory,
            outbox: outbox
        )

        try outbox.send(SomnioMessageEncoder.encode(.enterSector(EnterSectorMessage(sector: staticSector.asWire))))
        try outbox.send(SomnioMessageEncoder.encode(.mainCharacter(MainCharacterMessage(entityIndex: entityIndex))))
        try outbox.send(SomnioMessageEncoder.encode(.entity(makeEntityMessage(for: slot))))
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

        // Insert after streaming peers so a `try outbox.send` failure above leaves no
        // ghost slot in `players`.
        players[entityIndex] = slot
        lastAcceptedMoveAt[entityIndex] = ContinuousClock().now
        let newcomerEntity = SomnioMessage.entity(makeEntityMessage(for: slot))
        try broadcastToPeers(newcomerEntity, excluding: entityIndex)
        return entityIndex
    }

    /// Remove the slot and broadcast a `leave` to remaining peer outboxes. `leftGame == true`
    /// means the player disconnected entirely; `false` means a sector switch.
    public func detach(entityIndex: Int16, leftGame: Bool) {
        guard players.removeValue(forKey: entityIndex) != nil else { return }
        lastAcceptedMoveAt.removeValue(forKey: entityIndex)
        anomalyLogState.removeValue(forKey: entityIndex)
        do {
            try broadcastToPeers(.leave(LeaveMessage(entityIndex: entityIndex, leftGame: leftGame)), excluding: entityIndex)
        } catch {
            logger.warning("failed to broadcast leave", metadata: ["error": "\(error)", "entity_index": "\(entityIndex)"])
        }
    }

    /// Validate against sector bounds and collision masks; on success mutate the slot and
    /// broadcast the new position to peers. On failure snap the originating client back to the
    /// authoritative position so a move the client predicted against stale blocker data (a peer it
    /// had not yet seen) cannot leave the local and authoritative positions diverged.
    public func handlePosition(_ message: PositionMessage, from entityIndex: Int16) {
        guard var slot = players[entityIndex] else { return }
        guard let facing = Direction(rawValue: message.facing), let tempo = Tempo(rawValue: message.tempo) else {
            return
        }
        let newPosition = GridPoint(x: message.x, y: message.y)
        // Capture the authoritative position before the mutation below overwrites it — the
        // observe-only anomaly verdict measures the distance from here to `newPosition`.
        let previousPosition = slot.character.position
        // Feet-box gate: bounds + static masks + peers and NPCs — but deliberately NOT monsters. Static
        // blockers never move, so a client rejection there is a genuine stale-view bug worth a
        // `snapBack`. Monsters move every 50 ms AI tick, so the client's monster view is routinely a
        // frame stale; snapping the player back for a transient monster overlap would rubber-band
        // them backwards by up to a heartbeat. The monster AI tick already forbids a monster stepping
        // onto a player, and the client predictor keeps monsters soft-solid, so excluding them here
        // only relaxes the rare divergence frame instead of correcting it. Faithful to the legacy
        // trust-the-client model.
        guard feetBoxClear(
            at: newPosition,
            spriteSize: SomnioConstants.playerSpriteSize,
            excludingPlayer: entityIndex,
            includingMonsters: false
        ) else {
            snapBack(entityIndex: entityIndex)
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
        // Observe-only: the move is already committed and broadcast above. This neither rejects nor
        // snaps back — it only records implausibly-far accepted moves for offline analysis.
        instrumentAcceptedMove(from: previousPosition, to: newPosition, entityIndex: entityIndex, tempo: tempo)
    }

    /// Observe-only anomaly instrumentation for an already-accepted move. Emits a rate-limited,
    /// per-entity `warning` when the move covers more ground than running speed could in the elapsed
    /// interval — without rejecting or snapping back. The verdict baseline refreshes on every accepted
    /// move, including unflagged ones and early returns, so it always tracks the last accepted move.
    private func instrumentAcceptedMove(from previousPosition: GridPoint, to newPosition: GridPoint, entityIndex: Int16, tempo: Tempo) {
        let now = ContinuousClock().now
        defer { lastAcceptedMoveAt[entityIndex] = now }
        guard let baseline = lastAcceptedMoveAt[entityIndex] else { return }
        let elapsed = now - baseline
        let verdict = Self.movementReferenceVerdict(
            from: previousPosition,
            to: newPosition,
            elapsed: elapsed,
            toleranceFactor: Self.movementAnomalyToleranceFactor,
            flatSlackPixels: Self.movementAnomalyFlatSlackPixels,
            minElapsedSeconds: Self.movementAnomalyMinElapsedSeconds
        )
        guard verdict.exceeded else { return }
        let state = anomalyLogState[entityIndex]
        let decision = Self.anomalyLogDecision(
            sinceLastLog: state.map { now - $0.lastLoggedAt },
            suppressedCount: state?.suppressedCount ?? 0,
            interval: .seconds(Self.movementAnomalyLogIntervalSeconds)
        )
        guard decision.shouldLog else {
            anomalyLogState[entityIndex] = (lastLoggedAt: state?.lastLoggedAt ?? now, suppressedCount: decision.nextSuppressedCount)
            return
        }
        movementLogger.warning(
            "movement anomaly (observe-only)",
            metadata: [
                "entity_index": "\(entityIndex)",
                "from": "\(previousPosition.x),\(previousPosition.y)",
                "to": "\(newPosition.x),\(newPosition.y)",
                "distance": "\(verdict.distance)",
                "elapsed_ms": "\(Self.seconds(elapsed) * 1000)",
                "tempo": "\(tempo.rawValue)",
                "reference_cap": "\(verdict.referenceCap)",
                "would_reject": "true",
                "suppressed_since_last": "\(decision.suppressedSinceLast)"
            ]
        )
        anomalyLogState[entityIndex] = (lastLoggedAt: now, suppressedCount: 0)
    }

    /// Fractional seconds of a `Duration`, reconstructed from its `(seconds, attoseconds)` components
    /// (1 attosecond = 1e-18 s). One definition shared by the verdict cap and the `elapsed_ms` log so
    /// the subtle attoseconds conversion can't drift between the two.
    private static func seconds(_ duration: Duration) -> Double {
        Double(duration.components.seconds) + Double(duration.components.attoseconds) * 1e-18
    }

    /// Pure movement verdict: the Euclidean distance from `from` to `to`, the maximum distance a
    /// legitimately-running player could cover in `elapsed` (running speed × elapsed × tolerance + a
    /// flat slack), and whether the move exceeds it. Deltas widen to `Double` before squaring — like
    /// the monster-tick step — so a corrupt out-of-bounds baseline can't trap on an `Int16` square.
    /// `Tempo.run` (the max legitimate speed) is the ceiling, not the claimed `message.tempo`, so
    /// only faster-than-running moves flag.
    static func movementReferenceVerdict(
        from: GridPoint,
        to: GridPoint,
        elapsed: Duration,
        toleranceFactor: Double,
        flatSlackPixels: Double,
        minElapsedSeconds: Double
    ) -> (distance: Double, referenceCap: Double, exceeded: Bool) {
        let dx = Double(Int32(to.x) - Int32(from.x))
        let dy = Double(Int32(to.y) - Int32(from.y))
        let distance = (dx * dx + dy * dy).squareRoot()
        let referenceCap = Tempo.run.pixelsPerSecond * max(seconds(elapsed), minElapsedSeconds) * toleranceFactor + flatSlackPixels
        return (distance, referenceCap, distance > referenceCap)
    }

    /// Pure per-entity rate-limit decision for the anomaly log. `sinceLastLog` is the gap since this
    /// entity's last emitted line (`nil` when none yet). Emits when that gap is absent or at least
    /// `interval`, carrying the coalesced `suppressedSinceLast` count and resetting the running
    /// counter to 0; otherwise stays silent and increments the counter. Keeps output to at most one
    /// line per entity per interval even under deliberate teleport spam.
    static func anomalyLogDecision(
        sinceLastLog: Duration?,
        suppressedCount: Int,
        interval: Duration
    ) -> (shouldLog: Bool, suppressedSinceLast: Int, nextSuppressedCount: Int) {
        guard let sinceLastLog, sinceLastLog < interval else {
            return (shouldLog: true, suppressedSinceLast: suppressedCount, nextSuppressedCount: 0)
        }
        return (shouldLog: false, suppressedSinceLast: 0, nextSuppressedCount: suppressedCount + 1)
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
        guard isWithinDialogRadius(npc: npc, player: player) else { return }
        npc.targetingEntity = entityIndex
        npcs[npcIndex] = npc
    }

    /// True when `player` sits inside the NPC dialog interaction radius, measured between
    /// visual (feet) centers so off-center sprite art doesn't skew the gate. Shared by
    /// the bump gate and the dialog tick so both resolve "within dialog range" identically.
    private func isWithinDialogRadius(npc: NPCRuntime, player: PlayerSlot) -> Bool {
        let npcCenter = FeetMask.center(forSpriteAt: npc.position, spriteSize: npc.definition.maskSize)
        let playerCenter = FeetMask.center(
            forSpriteAt: player.character.position,
            spriteSize: SomnioConstants.playerSpriteSize
        )
        return VisualCenter.isWithin(npcCenter, playerCenter, radius: SomnioConstants.npcInteractionRadius)
    }

    /// One AI tick across the sector's NPCs and monsters. The deterministic mutator is the
    /// contracted test seam: `AITickService` calls this on a `Duration` cadence; tests drive
    /// it directly without sleeping. The returned `AITickDigest` flows out of actor isolation
    /// so the world router can persist dialog cursor changes through the repository without
    /// holding the actor.
    public func runAITick() -> AITickDigest {
        var digest = AITickDigest()
        runNPCTick(into: &digest)
        runMonsterSpawns()
        runMonsterTick()
        return digest
    }

    /// Advance every spawn timer and materialize a live monster when one reaches the threshold,
    /// gated by the sector-wide live-monster cap (`SomnioConstants.perSectorMonsterCap`). The cap
    /// freezes the timers across all spawns combined — a sector with several spawns shares one
    /// pool of three live monsters, matching the original's per-sector (not per-spawn) cap.
    private func runMonsterSpawns() {
        for index in spawnTimers.indices {
            guard monsters.count < SomnioConstants.perSectorMonsterCap else { continue }
            if spawnTimers[index].cooldownTicks >= monsterSpawnThreshold {
                // Only restart the cooldown once a monster actually materializes; if every cell in
                // the spawn box is blocked the timer stays armed and retries next tick, matching the
                // original's "loop placement until KollisionChecken clears" rather than dropping a
                // monster onto a blocked cell.
                if spawnMonster(from: spawnTimers[index].definition) {
                    spawnTimers[index].cooldownTicks = 0
                }
            } else {
                spawnTimers[index].cooldownTicks += 1
            }
        }
    }

    /// Materialize one live monster from a spawn definition: allocate its entity index, place it at
    /// a collision-free random point in the spawn box, and broadcast its `entity` to every attached
    /// player (there is no later join for an already-attached peer otherwise). Returns `false`
    /// without spawning when no clear cell is sampled, so the caller can retry rather than drop a
    /// monster onto geometry or another entity.
    private func spawnMonster(from definition: MonsterSpawn) -> Bool {
        let spawnRect = PixelRect(
            x: Int32(definition.spawnOrigin.x),
            y: Int32(definition.spawnOrigin.y),
            width: Int32(definition.spawnBoxSize.width),
            height: Int32(definition.spawnBoxSize.height)
        )
        guard let position = randomFreePoint(in: spawnRect, spriteSize: definition.spawnedMonsterSize) else {
            return false
        }
        guard let index = allocateEntityIndex() else { return false }
        let runtime = MonsterSpawnRuntime(entityIndex: index, definition: definition, position: position)
        monsters[index] = runtime
        do {
            try broadcastToAll(.entity(makeEntityMessage(for: runtime)))
        } catch {
            logger.warning(
                "failed to broadcast monster spawn",
                metadata: ["error": "\(error)", "monster_index": "\(index)"]
            )
        }
        return true
    }

    /// Destination-side arrival point for a player entering from `sourceSector`: a collision-free
    /// random cell inside the inbound (`arrivalPlacement`) portal whose `targetSectorName` is the
    /// source. Returns `nil` when no clear cell is sampled (the caller then defers to its own
    /// arrival-spawn fallback) and also when the sector has no matching inbound portal. Returning
    /// the unvalidated rect center on a fully-blocked portal would land the player in geometry or on
    /// another entity, so the `nil` defers placement to a validating fallback. Validates against
    /// live entities because this runs inside the actor that owns the roster.
    public func arrivalPlacement(fromSector sourceSector: String, spriteSize: GridSize) -> GridPoint? {
        guard let portal = staticSector.portals.first(where: {
            $0.direction == .arrivalPlacement && $0.targetSectorName == sourceSector
        }) else {
            return nil
        }
        // The original bounds the spawn top by the feet-mask height, but the feet mask sits at the
        // sprite's bottom, so that lets the feet box slide past the arrival rect's bottom edge —
        // onto a door directly below it. Reserve the full sprite height below the top instead, so a
        // random placement keeps the whole sprite (feet included) inside the authored arrival zone.
        // Random placement is otherwise preserved; this only corrects the original's off-by-one bound.
        let feetHeight = FeetMask.feetHeight(for: spriteSize)
        let reservedBelowTop = Int32(spriteSize.height) - feetHeight
        let samplingRect = PixelRect(
            x: Int32(portal.x),
            y: Int32(portal.y),
            width: Int32(portal.width),
            height: max(feetHeight, Int32(portal.height) - reservedBelowTop)
        )
        if let point = randomFreePoint(in: samplingRect, spriteSize: spriteSize) {
            return point
        }
        // No clear cell: defer to the caller's arrival-spawn fallback rather than return the
        // unvalidated rect center, which could land the player in geometry or on another entity.
        return nil
    }

    /// Random collision-free top-left point for a `spriteSize` sprite inside `rect`, retried up to
    /// `placementAttempts`. Mirrors the original `r.InRange(rect/4, (rect+box−mask)/4) * 4` 4px-grid
    /// sampling looped until `KollisionChecken` clears: the far edges are inset by the feet mask so
    /// the sprite fits, and each candidate is validated against static masks and live entities.
    private func randomFreePoint(in rect: PixelRect, spriteSize: GridSize) -> GridPoint? {
        let feetHeight = FeetMask.feetHeight(for: spriteSize)
        let loX = rect.x / 4
        let loY = rect.y / 4
        let hiX = max(loX, loX + rect.width / 4 - Int32(spriteSize.width) / 4)
        let hiY = max(loY, loY + rect.height / 4 - feetHeight / 4)
        // The roster can't change across the placement retries (we're inside actor isolation and
        // place a not-yet-allocated entity), so gather the blockers once instead of per candidate.
        let blockers = liveEntityFeetRects(excludingPlayer: nil, excludingMonster: nil)
        for _ in 0 ..< Self.placementAttempts {
            let candidate = GridPoint(
                x: Int16(clamping: Int32.random(in: loX ... hiX, using: &rng) * 4),
                y: Int16(clamping: Int32.random(in: loY ... hiY, using: &rng) * 4)
            )
            if FeetMask.isClear(at: candidate, spriteSize: spriteSize, sector: staticSector, blockers: blockers) {
                return candidate
            }
        }
        return nil
    }

    /// The single action `runNPCTick` resolves for one NPC on one tick. Computing it up
    /// front as a pure function of targeting + radius + cooldown + script state lets the
    /// apply step switch exhaustively, so a future state can't silently slip through an
    /// unhandled guard.
    private enum NPCDialogAction {
        /// No emit yet: progress the cooldown toward the cap. Covers idle (no target) and
        /// in-radius-but-pre-cooldown.
        case holdCooldown
        /// Target left the sector or walked out of radius: clear targeting + reset cursor,
        /// and persist the reset so it survives a restart.
        case resetTargeting
        /// In radius, cooldown ready, non-empty script: emit the current step substituting
        /// `targetName` for `$name`, then advance the cursor (wrapping at the final line).
        case emit(targetName: String)
        /// In radius, cooldown ready, but empty script: clear targeting so the next bump can
        /// re-arm. No emit, no cursor movement, no digest write.
        case clearTargetingNoEmit
    }

    /// Walks every NPC, resolves its one action for this tick, and applies it. The legacy
    /// `$name` token is substituted at emit time against the targeting player's name.
    private func runNPCTick(into digest: inout AITickDigest) {
        for (index, npcSnapshot) in npcs {
            var npc = npcSnapshot
            switch resolveDialogAction(for: npc) {
            case .holdCooldown:
                advanceCooldown(&npc)
            case .resetTargeting:
                resetTargeting(&npc, into: &digest)
            case .clearTargetingNoEmit:
                npc.targetingEntity = nil
            case let .emit(targetName):
                emitDialogStep(&npc, targetName: targetName, into: &digest)
            }
            npcs[index] = npc
        }
    }

    /// Classify what an NPC should do this tick. Pure read of `npc` + the live player set —
    /// no mutation, no broadcast — so the guard order is the single source of truth for the
    /// state machine and the apply step stays a flat exhaustive switch.
    private func resolveDialogAction(for npc: NPCRuntime) -> NPCDialogAction {
        guard let targetIndex = npc.targetingEntity else {
            // Idle: advance the cooldown so the next bump fires immediately.
            return .holdCooldown
        }
        guard let targetSlot = players[targetIndex] else {
            // Target left the sector.
            return .resetTargeting
        }
        guard isWithinDialogRadius(npc: npc, player: targetSlot) else {
            // Target walked out of radius. The legacy server resets both targeting and cursor
            // so one player who walks away mid-script cannot lock the NPC for everyone else.
            return .resetTargeting
        }
        guard npc.cooldownTicks == NPCRuntime.dialogCooldownCap else {
            // In radius but pre-cooldown: advance toward the cap and skip emit.
            return .holdCooldown
        }
        guard !npc.dialogSteps.isEmpty else {
            return .clearTargetingNoEmit
        }
        return .emit(targetName: targetSlot.character.name)
    }

    /// Emit the current dialog step, reset the cooldown, and advance the cursor — wrapping to
    /// step 0 + clearing targeting at the final line (so re-collision is required to restart).
    /// Records a digest reset on wrap or an upsert otherwise so the cursor survives a restart.
    private func emitDialogStep(_ npc: inout NPCRuntime, targetName: String, into digest: inout AITickDigest) {
        let step = npc.dialogSteps[Int(npc.scriptStepIndex)]
        let text = step.replacingOccurrences(of: "$name", with: targetName)
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
    }

    /// Advance an NPC's cooldown toward `NPCRuntime.dialogCooldownCap`. Shared by every
    /// non-emit path so "cooldown progresses while the next emit is still pending" has one
    /// definition.
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
            let monsterCenter = FeetMask.center(
                forSpriteAt: monster.position,
                spriteSize: monster.definition.spawnedMonsterSize
            )
            let aggroRadius = Int64(SomnioConstants.monsterAggroRadius)
            let aggroRadiusSquared = aggroRadius * aggroRadius
            // The chase only needs the closest-target's center, so the running candidate
            // tracks `(center, squared)` rather than the full `PlayerSlot`. The single
            // `squaredDistance` per candidate doubles as the aggro-radius gate to avoid
            // recomputing the distance twice.
            var closest: (center: (x: Int32, y: Int32), squared: Int64)?
            for slot in players.values {
                let candidateCenter = FeetMask.center(
                    forSpriteAt: slot.character.position,
                    spriteSize: SomnioConstants.playerSpriteSize
                )
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
            // Chase step: 6 px Euclidean per tick toward the target. On a 45° diagonal this
            // yields ≈(4, 4); Manhattan-based scaling would yield (3, 3), visibly slower.
            // `max(length, 1)` keeps the division safe at coincident centers — unreachable in
            // bounds, since the move gate forbids feet-box overlap, but cheap to guard.
            let length = max((Double(dx) * Double(dx) + Double(dy) * Double(dy)).squareRoot(), 1)
            let stepDx = Int32((Double(dx) * 6.0 / length).rounded())
            let stepDy = Int32((Double(dy) * 6.0 / length).rounded())
            // Clamp into `Int16` so a monster near a near-`Int16.max` sector edge cannot
            // trap on the position add. The subsequent `isInside` gate keeps in-bounds
            // semantics intact for the runtime position.
            let proposed = GridPoint(
                x: Int16(clamping: Int32(monster.position.x) + stepDx),
                y: Int16(clamping: Int32(monster.position.y) + stepDy)
            )
            // Feet-box gate against static masks and every other live entity, so a monster
            // neither walks into geometry nor stacks onto another entity (`excludingMonster`
            // keeps it from blocking itself).
            if feetBoxClear(
                at: proposed,
                spriteSize: monster.definition.spawnedMonsterSize,
                excludingMonster: monster.entityIndex
            ) {
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

    /// Re-emit the player's authoritative `serverPosition` to the originating connection so the
    /// client snaps back after the server rejects a client-proposed change — an `enterPortal` to an
    /// unknown destination, or a move that fails the feet-box gate.
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

    /// Feet-box clearance for a `spriteSize` sprite at `position` against this sector's static masks
    /// and other live entities. `excludingPlayer` / `excludingMonster` drop the mover from the
    /// blocker set so it never collides with itself; `includingMonsters` drops every monster from
    /// the set (the player move gate uses this — see `handlePosition`). Geometry lives in
    /// `FeetMask.isClear`.
    private func feetBoxClear(
        at position: GridPoint,
        spriteSize: GridSize,
        excludingPlayer: Int16? = nil,
        excludingMonster: Int16? = nil,
        includingMonsters: Bool = true
    ) -> Bool {
        let blockers = liveEntityFeetRects(
            excludingPlayer: excludingPlayer,
            excludingMonster: excludingMonster,
            includingMonsters: includingMonsters
        )
        return FeetMask.isClear(at: position, spriteSize: spriteSize, sector: staticSector, blockers: blockers)
    }

    /// Feet boxes of live entities (players, NPCs, and — when `includingMonsters` — monsters),
    /// optionally excluding one player or one monster so the mover does not block itself.
    private func liveEntityFeetRects(
        excludingPlayer: Int16?,
        excludingMonster: Int16?,
        includingMonsters: Bool = true
    ) -> [PixelRect] {
        var rects: [PixelRect] = []
        for (index, slot) in players where index != excludingPlayer {
            rects.append(FeetMask.rect(forSpriteAt: slot.character.position, spriteSize: SomnioConstants.playerSpriteSize))
        }
        for npc in npcs.values {
            rects.append(FeetMask.rect(forSpriteAt: npc.position, spriteSize: npc.definition.maskSize))
        }
        if includingMonsters {
            for (index, monster) in monsters where index != excludingMonster {
                rects.append(FeetMask.rect(forSpriteAt: monster.position, spriteSize: monster.definition.spawnedMonsterSize))
            }
        }
        return rects
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
            // The player sprite cell is 32 x 48, not the 128 x 128 engine tile; the wire mask is
            // the sprite cell (also the untextured-fallback size and the feet-box source).
            maskWidth: SomnioConstants.playerSpriteSize.width,
            maskHeight: SomnioConstants.playerSpriteSize.height,
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
            // `NPC.direction` stores the legacy `richtung` (S=0,W=1,E=2,N=3); convert it to
            // a semantic `Direction` so the wire carries `Direction.rawValue` like every other
            // entity. The field stays richtung-encoded — the conversion lives at the emit seam.
            facing: (Direction(legacyRichtung: npc.definition.direction) ?? .south).rawValue,
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
