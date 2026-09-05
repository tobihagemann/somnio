import { WIRE_ENTITY_TYPE, encodeSomnioMessage } from '@somnio/protocol'
import type { EntityMessage, PositionMessage, SayMessage, SomnioMessage, WireHand } from '@somnio/protocol'
import {
  SOMNIO_CONSTANTS,
  TEMPO,
  clampToInt16,
  dialogSteps,
  feetCenter,
  feetHeight,
  feetRect,
  heading,
  headingFromCardinal,
  headingFromVector,
  inventoryRowToWire,
  isFeetClear,
  isWithin,
  npcRuntimePosition,
  sectorToWire,
  squaredDistance,
  tempoPixelsPerSecond,
} from '@somnio/core'
import type {
  Character,
  GridPoint,
  GridSize,
  Hand,
  Heading,
  InventoryRow,
  MonsterSpawn,
  NPCDialogState,
  PixelRect,
  Sector,
  SectorNPC,
  Tempo,
} from '@somnio/core'
import { handFromWire } from '@somnio/core'
import { encodeOrWarn } from '../connection/encodeFrame.ts'
import type { ConnectionOutbox } from '../connection/outbox.ts'
import type { Logger } from '../logging.ts'
import { advanceEntityIndex, nextFreeIndex, npcEntityIndices } from './entityIndex.ts'
import { randomInRange, systemRandom } from './random.ts'
import type { RandomSource } from './random.ts'

/** Per-player runtime slot in a sector. */
interface PlayerSlot {
  entityIndex: number
  character: Character
  inventory: InventoryRow[]
  outbox: ConnectionOutbox
}

/**
 * Per-NPC runtime state. `position` is materialized via `npcRuntimePosition` at load so the codec
 * stays placement-agnostic; `dialogSteps` caches the parsed script so the tick allocates nothing.
 */
interface NPCRuntime {
  entityIndex: number
  definition: SectorNPC
  position: GridPoint
  targetingEntity: number | undefined
  dialogSteps: string[]
  cooldownTicks: number
  /** 0-based cursor into `dialogSteps`. Persisted as 1-based; translated at the seam. */
  scriptStepIndex: number
}

interface MonsterRuntime {
  entityIndex: number
  definition: MonsterSpawn
  position: GridPoint
  /** Rotated toward the chase target; idle monsters keep the south spawn facing. */
  facing: Heading
}

/** Per-`MonsterSpawn` cadence: advanced by the tick while below the live-monster cap. */
interface MonsterSpawnTimer {
  definition: MonsterSpawn
  cooldownTicks: number
}

/** One player's persistent state, for the shutdown drain and periodic checkpointer. */
export interface PlayerCheckpoint {
  character: Character
  inventory: InventoryRow[]
}

/** One tick's persistence digest; the router applies it outside the actor so a failed write cannot corrupt in-process state. */
export interface AITickDigest {
  dialogUpserts: NPCDialogState[]
  /** NPC indices whose dialog row is deleted: a reset persists a deletion, not a full state. */
  dialogResets: number[]
}

/** The AI-tick cadence in seconds, paired with `npcDialogCooldownSeconds` for the dialog cap. */
export const DEFAULT_AI_TICK_INTERVAL_SECONDS = 0.05
/**
 * Cap the per-tick dialog cooldown counter advances toward; seeded to the cap so the first bump
 * emits immediately. `cooldown / tick` ticks per cooldown, minus one because the counter starts
 * at 0 and the emit gate is `===`, so readiness lands one tick early.
 */
export const DIALOG_COOLDOWN_CAP =
  Math.trunc(SOMNIO_CONSTANTS.npcDialogCooldownSeconds / DEFAULT_AI_TICK_INTERVAL_SECONDS) - 1
/** ~60 s at the 50 ms cadence: 1199 ticks, so the first spawn lands on tick 1200. */
export const DEFAULT_MONSTER_SPAWN_THRESHOLD = 1199
const PLACEMENT_ATTEMPTS = 64

/**
 * Observe-only movement-anomaly thresholds. A move is flagged (logged, never rejected) when it
 * covers more ground than running speed × elapsed × tolerance + a flat slack.
 */
const MOVEMENT_ANOMALY = {
  toleranceFactor: 2,
  flatSlackPixels: SOMNIO_CONSTANTS.tileSize,
  /** Floor on the elapsed interval so rapid messages cannot shrink the cap to the slack alone. */
  minElapsedSeconds: DEFAULT_AI_TICK_INTERVAL_SECONDS,
  /** Minimum gap between anomaly log lines per entity; anomalies in between are coalesced. */
  logIntervalSeconds: 5,
} as const

export interface MovementVerdict {
  distance: number
  referenceCap: number
  exceeded: boolean
}

/**
 * Pure movement verdict: the Euclidean distance of the move, the maximum a legitimately running
 * player could cover in `elapsedSeconds` (with the floor and the slack), and whether the move
 * exceeds it. `Tempo.run` is the ceiling, not the claimed tempo, so only faster-than-running flags.
 */
export function movementReferenceVerdict(
  from: GridPoint,
  to: GridPoint,
  elapsedSeconds: number,
  toleranceFactor: number,
  flatSlackPixels: number,
  minElapsedSeconds: number
): MovementVerdict {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.sqrt(dx * dx + dy * dy)
  const referenceCap =
    tempoPixelsPerSecond(TEMPO.run) * Math.max(elapsedSeconds, minElapsedSeconds) * toleranceFactor +
    flatSlackPixels
  return { distance, referenceCap, exceeded: distance > referenceCap }
}

export interface AnomalyLogDecision {
  shouldLog: boolean
  suppressedSinceLast: number
  nextSuppressedCount: number
}

/**
 * Per-entity rate limit for the anomaly log: emits when there is no prior line or the gap is at
 * least `intervalSeconds`, carrying the coalesced count; otherwise stays silent and counts.
 */
export function anomalyLogDecision(
  sinceLastLogSeconds: number | undefined,
  suppressedCount: number,
  intervalSeconds: number
): AnomalyLogDecision {
  if (sinceLastLogSeconds === undefined || sinceLastLogSeconds >= intervalSeconds) {
    return { shouldLog: true, suppressedSinceLast: suppressedCount, nextSuppressedCount: 0 }
  }
  return { shouldLog: false, suppressedSinceLast: 0, nextSuppressedCount: suppressedCount + 1 }
}

export interface PerSectorActorOptions {
  logger: Logger
  /** Persisted 1-based dialog cursors by NPC entity index. */
  initialDialogCursors?: ReadonlyMap<number, number>
  random?: RandomSource
  monsterSpawnThreshold?: number
  /** Monotonic milliseconds, for the movement instrumentation. */
  now?: () => number
}

type NPCDialogAction =
  | { kind: 'holdCooldown' }
  | { kind: 'resetTargeting' }
  | { kind: 'emit'; targetName: string }
  | { kind: 'clearTargetingNoEmit' }

/**
 * One sector's runtime: its player set, NPC and monster placement, and the broadcast stream that
 * funnels every peer-visible mutation through outboxes. Every method is synchronous, so Node's
 * run-to-completion supplies the isolation the name implies; persistence is dispatched by the
 * router outside the sector.
 */
export class PerSectorActor {
  readonly staticSector: Sector
  private readonly players = new Map<number, PlayerSlot>()
  private readonly npcs = new Map<number, NPCRuntime>()
  private readonly monsters = new Map<number, MonsterRuntime>()
  private readonly spawnTimers: MonsterSpawnTimer[]
  private readonly random: RandomSource
  private readonly monsterSpawnThreshold: number
  private readonly now: () => number
  private nextEntityIndex: number
  private readonly logger: Logger
  private readonly lastAcceptedMoveAt = new Map<number, number>()
  private readonly anomalyLogState = new Map<number, { lastLoggedAt: number; suppressedCount: number }>()

  constructor(staticSector: Sector, options: PerSectorActorOptions) {
    this.staticSector = staticSector
    this.logger = options.logger
    this.random = options.random ?? systemRandom
    this.monsterSpawnThreshold = options.monsterSpawnThreshold ?? DEFAULT_MONSTER_SPAWN_THRESHOLD
    this.now = options.now ?? (() => performance.now())
    this.spawnTimers = staticSector.monsterSpawns.map((definition) => ({ definition, cooldownTicks: 0 }))
    const indices = npcEntityIndices(staticSector.npcs.length)
    staticSector.npcs.forEach((npc, position) => {
      const index = indices[position]!
      const steps = dialogSteps(npc.dialogScript)
      this.npcs.set(index, {
        entityIndex: index,
        definition: npc,
        position: npcRuntimePosition(npc),
        targetingEntity: undefined,
        dialogSteps: steps,
        cooldownTicks: DIALOG_COOLDOWN_CAP,
        scriptStepIndex: this.resolveSeedStepIndex(
          options.initialDialogCursors?.get(index),
          steps.length,
          index
        ),
      })
    })
    // Monsters spawn at runtime and allocate from the index after the last NPC (or 1).
    const last = indices[indices.length - 1]
    this.nextEntityIndex = last === undefined ? 1 : advanceEntityIndex(last)
  }

  /**
   * Translates a persisted 1-based `script_step` into the 0-based cursor. Out-of-range values
   * clamp to 0 with a warning so a shortened script is visible rather than silently rewound.
   */
  private resolveSeedStepIndex(persisted: number | undefined, stepCount: number, npcIndex: number): number {
    if (persisted === undefined) return 0
    if (stepCount === 0) {
      if (persisted !== 1) {
        this.logger.warn(
          { sector: this.staticSector.name, npc_index: npcIndex, persisted_step: persisted },
          'npc dialog cursor reset (script empty)'
        )
      }
      return 0
    }
    if (persisted < 1 || persisted > stepCount) {
      this.logger.warn(
        {
          sector: this.staticSector.name,
          npc_index: npcIndex,
          persisted_step: persisted,
          step_count: stepCount,
        },
        'npc dialog cursor clamped (out of range)'
      )
      return 0
    }
    return persisted - 1
  }

  private allocateEntityIndex(): number | undefined {
    const index = nextFreeIndex(
      this.nextEntityIndex,
      (candidate) => this.players.has(candidate) || this.npcs.has(candidate) || this.monsters.has(candidate)
    )
    if (index === undefined) {
      this.logger.error({ sector: this.staticSector.name }, 'sector full: entity-index space exhausted')
      return undefined
    }
    this.nextEntityIndex = advanceEntityIndex(index)
    return index
  }

  /**
   * Allocates a slot, streams the join sequence to the newcomer's outbox, and broadcasts one
   * `entity` for the newcomer to existing peers. Throws when the join sequence cannot be encoded
   * or the index space is exhausted; a throw leaves no slot behind, though the allocated index
   * number and any frames already queued on the outbox are consumed.
   */
  attach(character: Character, inventory: InventoryRow[], outbox: ConnectionOutbox): number {
    const entityIndex = this.allocateEntityIndex()
    if (entityIndex === undefined) throw new Error('sector full')
    const slot: PlayerSlot = { entityIndex, character, inventory, outbox }

    outbox.send(
      encodeSomnioMessage({ tag: 'enterSector', payload: { sector: sectorToWire(this.staticSector) } })
    )
    outbox.send(encodeSomnioMessage({ tag: 'mainCharacter', payload: { entityIndex } }))
    outbox.send(encodeSomnioMessage({ tag: 'entity', payload: this.playerEntity(slot) }))
    outbox.send(
      encodeSomnioMessage({ tag: 'inventory', payload: { rows: inventory.map(inventoryRowToWire) } })
    )
    outbox.send(encodeSomnioMessage({ tag: 'energy', payload: character.energy }))
    for (const peer of this.players.values()) {
      outbox.send(encodeSomnioMessage({ tag: 'entity', payload: this.playerEntity(peer) }))
    }
    for (const npc of this.npcs.values()) {
      outbox.send(encodeSomnioMessage({ tag: 'entity', payload: this.npcEntity(npc) }))
    }
    for (const monster of this.monsters.values()) {
      outbox.send(encodeSomnioMessage({ tag: 'entity', payload: this.monsterEntity(monster) }))
    }

    this.players.set(entityIndex, slot)
    this.lastAcceptedMoveAt.set(entityIndex, this.now())
    this.broadcastToPeers({ tag: 'entity', payload: this.playerEntity(slot) }, entityIndex)
    return entityIndex
  }

  /** `leftGame` is `true` for a disconnect and `false` for a sector switch. */
  detach(entityIndex: number, leftGame: boolean): void {
    if (!this.players.delete(entityIndex)) return
    this.lastAcceptedMoveAt.delete(entityIndex)
    this.anomalyLogState.delete(entityIndex)
    this.broadcastToPeers({ tag: 'leave', payload: { entityIndex, leftGame } }, entityIndex)
  }

  /**
   * Feet-box gate against bounds, static masks, peers, and NPCs — deliberately not monsters, which
   * move every tick and would rubber-band the player for a transient overlap. A rejected move
   * snaps the originating client back to the authoritative position.
   */
  handlePosition(message: PositionMessage, entityIndex: number): void {
    const slot = this.players.get(entityIndex)
    if (slot === undefined) return
    const tempo = tempoOrUndefined(message.tempo)
    if (tempo === undefined) return
    const newPosition = { x: message.x, y: message.y }
    const previousPosition = slot.character.position
    if (
      !this.feetBoxClear(newPosition, SOMNIO_CONSTANTS.playerSpriteSize, {
        excludingPlayer: entityIndex,
        includingMonsters: false,
      })
    ) {
      this.snapBack(entityIndex)
      return
    }
    // Wrapped into `[0, 360)` once, so storage and the broadcast carry the same normalized value.
    const facing = heading(message.facing)
    slot.character = { ...slot.character, position: newPosition, facing, tempo }
    this.broadcastToPeers(
      { tag: 'serverPosition', payload: { entityIndex, x: newPosition.x, y: newPosition.y, facing, tempo } },
      entityIndex
    )
    this.instrumentAcceptedMove(previousPosition, newPosition, entityIndex, tempo)
  }

  private instrumentAcceptedMove(from: GridPoint, to: GridPoint, entityIndex: number, tempo: Tempo): void {
    const now = this.now()
    const baseline = this.lastAcceptedMoveAt.get(entityIndex)
    this.lastAcceptedMoveAt.set(entityIndex, now)
    if (baseline === undefined) return
    const elapsedSeconds = (now - baseline) / 1000
    const verdict = movementReferenceVerdict(
      from,
      to,
      elapsedSeconds,
      MOVEMENT_ANOMALY.toleranceFactor,
      MOVEMENT_ANOMALY.flatSlackPixels,
      MOVEMENT_ANOMALY.minElapsedSeconds
    )
    if (!verdict.exceeded) return
    const state = this.anomalyLogState.get(entityIndex)
    const decision = anomalyLogDecision(
      state === undefined ? undefined : (now - state.lastLoggedAt) / 1000,
      state?.suppressedCount ?? 0,
      MOVEMENT_ANOMALY.logIntervalSeconds
    )
    if (!decision.shouldLog) {
      this.anomalyLogState.set(entityIndex, {
        lastLoggedAt: state?.lastLoggedAt ?? now,
        suppressedCount: decision.nextSuppressedCount,
      })
      return
    }
    this.logger.warn(
      {
        entity_index: entityIndex,
        from: `${from.x},${from.y}`,
        to: `${to.x},${to.y}`,
        distance: verdict.distance,
        elapsed_ms: elapsedSeconds * 1000,
        tempo,
        reference_cap: verdict.referenceCap,
        would_reject: true,
        suppressed_since_last: decision.suppressedSinceLast,
      },
      'movement anomaly (observe-only)'
    )
    this.anomalyLogState.set(entityIndex, { lastLoggedAt: now, suppressedCount: 0 })
  }

  /** Re-broadcasts a chat line to peers; the originating client renders its own bubble. */
  handleSay(message: SayMessage, entityIndex: number): void {
    if (!this.players.has(entityIndex)) return
    this.broadcastToPeers({ tag: 'serverSay', payload: { entityIndex, text: message.text } }, entityIndex)
  }

  /**
   * Per-row equip with an implicit unequip of any other row holding the same hand; returns the
   * post-mutation rows. Equip markers are per-player UI, so the result is re-emitted to the
   * originating connection and never broadcast.
   */
  handleEquipToggle(slot: number, hand: WireHand, entityIndex: number): InventoryRow[] | undefined {
    const player = this.players.get(entityIndex)
    if (player === undefined) return undefined
    const rowIndex = player.inventory.findIndex((row) => row.slot === slot)
    if (rowIndex === -1) return undefined
    const coreHand: Hand | undefined = handFromWire(hand)
    player.inventory = player.inventory.map((row, index) => {
      if (index === rowIndex) return { ...row, equippedHand: coreHand }
      if (coreHand !== undefined && row.equippedHand === coreHand) return { ...row, equippedHand: undefined }
      return row
    })
    return player.inventory
  }

  /**
   * Flips the NPC's targeting once; a second bump while already targeting is a no-op so the
   * dialog is not retargeted mid-script, and a bump from outside the dialog radius is dropped so
   * it cannot force per-call writes through the tick's reset path.
   */
  handleBumpNPC(npcIndex: number, entityIndex: number): void {
    const player = this.players.get(entityIndex)
    const npc = this.npcs.get(npcIndex)
    if (player === undefined || npc === undefined) return
    if (npc.targetingEntity !== undefined) return
    if (!this.isWithinDialogRadius(npc, player)) return
    npc.targetingEntity = entityIndex
  }

  private isWithinDialogRadius(npc: NPCRuntime, player: PlayerSlot): boolean {
    return isWithin(
      feetCenter(npc.position, npc.definition.maskSize),
      feetCenter(player.character.position, SOMNIO_CONSTANTS.playerSpriteSize),
      SOMNIO_CONSTANTS.npcInteractionRadius
    )
  }

  /** One AI tick: NPC dialog, monster spawns, monster chase. The test seam the tick service drives. */
  runAITick(): AITickDigest {
    const digest: AITickDigest = { dialogUpserts: [], dialogResets: [] }
    this.runNPCTick(digest)
    this.runMonsterSpawns()
    this.runMonsterTick()
    return digest
  }

  /** Advances every spawn timer; the sector-wide cap freezes all timers together. */
  private runMonsterSpawns(): void {
    for (const timer of this.spawnTimers) {
      if (this.monsters.size >= SOMNIO_CONSTANTS.perSectorMonsterCap) continue
      if (timer.cooldownTicks >= this.monsterSpawnThreshold) {
        // The cooldown restarts only once a monster materializes; a fully blocked box keeps the
        // timer armed and retries next tick rather than dropping a monster onto geometry.
        if (this.spawnMonster(timer.definition)) timer.cooldownTicks = 0
      } else {
        timer.cooldownTicks += 1
      }
    }
  }

  private spawnMonster(definition: MonsterSpawn): boolean {
    const spawnRect: PixelRect = {
      x: definition.spawnOrigin.x,
      y: definition.spawnOrigin.y,
      width: definition.spawnBoxSize.width,
      height: definition.spawnBoxSize.height,
    }
    const position = this.randomFreePoint(spawnRect, definition.spawnedMonsterSize)
    if (position === undefined) return false
    const index = this.allocateEntityIndex()
    if (index === undefined) return false
    const runtime: MonsterRuntime = {
      entityIndex: index,
      definition,
      position,
      facing: headingFromCardinal('south'),
    }
    this.monsters.set(index, runtime)
    this.broadcastToAll({ tag: 'entity', payload: this.monsterEntity(runtime) })
    return true
  }

  /**
   * A collision-free random point inside the inbound `arrivalPlacement` portal targeting
   * `sourceSector`, or `undefined` when there is no such portal or no clear cell (the caller then
   * falls back to a validating arrival spawn). The sprite's non-feet height is trimmed off the
   * rect's bottom so the feet box cannot slide past the bottom edge onto a door directly below.
   */
  arrivalPlacement(sourceSector: string, spriteSize: GridSize): GridPoint | undefined {
    const portal = this.staticSector.portals.find(
      (candidate) => candidate.direction === 'arrivalPlacement' && candidate.targetSectorName === sourceSector
    )
    if (portal === undefined) return undefined
    const feet = feetHeight(spriteSize)
    const reservedBelowTop = spriteSize.height - feet
    const samplingRect: PixelRect = {
      x: portal.x,
      y: portal.y,
      width: portal.width,
      height: Math.max(feet, portal.height - reservedBelowTop),
    }
    return this.randomFreePoint(samplingRect, spriteSize)
  }

  /** 4px-grid sampling inside `rect`, validated against masks and live entities, up to the retry cap. */
  private randomFreePoint(rect: PixelRect, spriteSize: GridSize): GridPoint | undefined {
    const feet = feetHeight(spriteSize)
    const loX = Math.trunc(rect.x / 4)
    const loY = Math.trunc(rect.y / 4)
    const hiX = Math.max(loX, loX + Math.trunc(rect.width / 4) - Math.trunc(spriteSize.width / 4))
    const hiY = Math.max(loY, loY + Math.trunc(rect.height / 4) - Math.trunc(feet / 4))
    const blockers = this.liveEntityFeetRects({})
    for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt += 1) {
      const candidate = {
        x: clampToInt16(randomInRange(this.random, loX, hiX) * 4),
        y: clampToInt16(randomInRange(this.random, loY, hiY) * 4),
      }
      if (isFeetClear(candidate, spriteSize, this.staticSector, blockers)) return candidate
    }
    return undefined
  }

  private runNPCTick(digest: AITickDigest): void {
    for (const npc of this.npcs.values()) {
      const action = this.resolveDialogAction(npc)
      switch (action.kind) {
        case 'holdCooldown':
          this.advanceCooldown(npc)
          break
        case 'resetTargeting':
          this.resetTargeting(npc, digest)
          break
        case 'clearTargetingNoEmit':
          npc.targetingEntity = undefined
          break
        case 'emit':
          this.emitDialogStep(npc, action.targetName, digest)
          break
      }
    }
  }

  private resolveDialogAction(npc: NPCRuntime): NPCDialogAction {
    if (npc.targetingEntity === undefined) return { kind: 'holdCooldown' }
    const target = this.players.get(npc.targetingEntity)
    if (target === undefined) return { kind: 'resetTargeting' }
    if (!this.isWithinDialogRadius(npc, target)) return { kind: 'resetTargeting' }
    if (npc.cooldownTicks !== DIALOG_COOLDOWN_CAP) return { kind: 'holdCooldown' }
    if (npc.dialogSteps.length === 0) return { kind: 'clearTargetingNoEmit' }
    return { kind: 'emit', targetName: target.character.name }
  }

  /** Emits the current step, resets the cooldown, and advances the cursor, wrapping (and clearing targeting) at the last line. */
  private emitDialogStep(npc: NPCRuntime, targetName: string, digest: AITickDigest): void {
    const step = npc.dialogSteps[npc.scriptStepIndex]!
    this.broadcastToAll({
      tag: 'serverSay',
      payload: { entityIndex: npc.entityIndex, text: step.replaceAll('$name', targetName) },
    })
    npc.cooldownTicks = 0
    const nextIndex = npc.scriptStepIndex + 1
    if (nextIndex >= npc.dialogSteps.length) {
      npc.scriptStepIndex = 0
      npc.targetingEntity = undefined
      digest.dialogResets.push(npc.entityIndex)
    } else {
      npc.scriptStepIndex = nextIndex
      digest.dialogUpserts.push({
        sectorName: this.staticSector.name,
        npcIndex: npc.entityIndex,
        scriptStep: nextIndex + 1,
      })
    }
  }

  private advanceCooldown(npc: NPCRuntime): void {
    if (npc.cooldownTicks < DIALOG_COOLDOWN_CAP) npc.cooldownTicks += 1
  }

  private resetTargeting(npc: NPCRuntime, digest: AITickDigest): void {
    npc.targetingEntity = undefined
    npc.scriptStepIndex = 0
    this.advanceCooldown(npc)
    digest.dialogResets.push(npc.entityIndex)
  }

  /** Branch-0 monsters orient and chase the nearest in-aggro player; other scripts idle. */
  private runMonsterTick(): void {
    for (const monster of this.monsters.values()) {
      if (monster.definition.aiScriptIndex !== 0) continue
      const monsterCenter = feetCenter(monster.position, monster.definition.spawnedMonsterSize)
      const aggroSquared = SOMNIO_CONSTANTS.monsterAggroRadius * SOMNIO_CONSTANTS.monsterAggroRadius
      let closest: { center: { x: number; y: number }; squared: number } | undefined
      for (const slot of this.players.values()) {
        const center = feetCenter(slot.character.position, SOMNIO_CONSTANTS.playerSpriteSize)
        const squared = squaredDistance(monsterCenter, center)
        if (squared > aggroSquared) continue
        if (closest !== undefined && squared >= closest.squared) continue
        closest = { center, squared }
      }
      if (closest === undefined) continue
      const dx = closest.center.x - monsterCenter.x
      const dy = closest.center.y - monsterCenter.y
      monster.facing = headingFromVector(dx, dy)
      // 6 px Euclidean per tick toward the target; `max(length, 1)` guards coincident centers.
      const length = Math.max(Math.sqrt(dx * dx + dy * dy), 1)
      const proposed = {
        x: clampToInt16(monster.position.x + Math.round((dx * 6) / length)),
        y: clampToInt16(monster.position.y + Math.round((dy * 6) / length)),
      }
      if (
        this.feetBoxClear(proposed, monster.definition.spawnedMonsterSize, {
          excludingMonster: monster.entityIndex,
        })
      ) {
        monster.position = proposed
      }
      this.broadcastToAll({
        tag: 'serverPosition',
        payload: {
          entityIndex: monster.entityIndex,
          x: monster.position.x,
          y: monster.position.y,
          facing: monster.facing,
          tempo: TEMPO.default,
        },
      })
    }
  }

  /** Re-emits the authoritative `serverPosition` to the originating connection after a rejected change. */
  snapBack(entityIndex: number): void {
    const slot = this.players.get(entityIndex)
    if (slot === undefined) return
    slot.outbox.sendEncoded(
      {
        tag: 'serverPosition',
        payload: {
          entityIndex,
          x: slot.character.position.x,
          y: slot.character.position.y,
          facing: slot.character.facing,
          tempo: slot.character.tempo,
        },
      },
      this.logger
    )
  }

  /** One snapshot per player, bumping `lastSeen` so the router can order it against a racing disconnect snapshot. */
  snapshotForCheckpoint(): PlayerCheckpoint[] {
    const now = new Date()
    const result: PlayerCheckpoint[] = []
    for (const slot of this.players.values()) {
      slot.character = { ...slot.character, lastSeen: now }
      result.push({ character: slot.character, inventory: slot.inventory })
    }
    return result
  }

  snapshotForPlayer(entityIndex: number): PlayerCheckpoint | undefined {
    const slot = this.players.get(entityIndex)
    if (slot === undefined) return undefined
    slot.character = { ...slot.character, lastSeen: new Date() }
    return { character: slot.character, inventory: slot.inventory }
  }

  private feetBoxClear(
    position: GridPoint,
    spriteSize: GridSize,
    options: { excludingPlayer?: number; excludingMonster?: number; includingMonsters?: boolean }
  ): boolean {
    return isFeetClear(position, spriteSize, this.staticSector, this.liveEntityFeetRects(options))
  }

  private liveEntityFeetRects(options: {
    excludingPlayer?: number
    excludingMonster?: number
    includingMonsters?: boolean
  }): PixelRect[] {
    const rects: PixelRect[] = []
    for (const [index, slot] of this.players) {
      if (index !== options.excludingPlayer)
        rects.push(feetRect(slot.character.position, SOMNIO_CONSTANTS.playerSpriteSize))
    }
    for (const npc of this.npcs.values()) rects.push(feetRect(npc.position, npc.definition.maskSize))
    if (options.includingMonsters ?? true) {
      for (const [index, monster] of this.monsters) {
        if (index !== options.excludingMonster) {
          rects.push(feetRect(monster.position, monster.definition.spawnedMonsterSize))
        }
      }
    }
    return rects
  }

  private broadcastToPeers(message: SomnioMessage, excluding: number): void {
    const frame = encodeOrWarn(message, this.logger)
    if (frame === undefined) return
    for (const [index, slot] of this.players) {
      if (index !== excluding) slot.outbox.send(frame)
    }
  }

  /** Encode once and fan out to every slot, including the one whose proximity caused the broadcast. */
  private broadcastToAll(message: SomnioMessage): void {
    const frame = encodeOrWarn(message, this.logger)
    if (frame === undefined) return
    for (const slot of this.players.values()) slot.outbox.send(frame)
  }

  private playerEntity(slot: PlayerSlot): EntityMessage {
    return {
      entityIndex: slot.entityIndex,
      figure: slot.character.figure,
      gender: slot.character.gender,
      // The player sprite cell is 32 x 48, not the engine tile; the wire mask is the sprite cell.
      maskWidth: SOMNIO_CONSTANTS.playerSpriteSize.width,
      maskHeight: SOMNIO_CONSTANTS.playerSpriteSize.height,
      type: WIRE_ENTITY_TYPE.player,
      name: slot.character.name,
      x: slot.character.position.x,
      y: slot.character.position.y,
      facing: slot.character.facing,
      tempo: slot.character.tempo,
    }
  }

  private npcEntity(npc: NPCRuntime): EntityMessage {
    return {
      entityIndex: npc.entityIndex,
      figure: npc.definition.figure,
      gender: 0,
      maskWidth: npc.definition.maskSize.width,
      maskHeight: npc.definition.maskSize.height,
      type: WIRE_ENTITY_TYPE.npc,
      name: npc.definition.name,
      x: npc.position.x,
      y: npc.position.y,
      facing: npc.definition.facing,
      tempo: 0,
    }
  }

  private monsterEntity(monster: MonsterRuntime): EntityMessage {
    return {
      entityIndex: monster.entityIndex,
      figure: monster.definition.figure,
      gender: 0,
      maskWidth: monster.definition.spawnedMonsterSize.width,
      maskHeight: monster.definition.spawnedMonsterSize.height,
      type: WIRE_ENTITY_TYPE.monster,
      name: monster.definition.name,
      x: monster.position.x,
      y: monster.position.y,
      facing: monster.facing,
      tempo: 0,
    }
  }
}

function tempoOrUndefined(raw: number): Tempo | undefined {
  return raw === TEMPO.walk || raw === TEMPO.default || raw === TEMPO.run ? raw : undefined
}
