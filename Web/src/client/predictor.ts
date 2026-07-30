import {
  SOMNIO_CONSTANTS,
  angularDistance,
  clamp,
  clampToInt16,
  clampToSector,
  feetRect,
  headingFromVector,
  isFeetClear,
  overlaps,
  portalTriggerRects,
  relativeDirection,
  roundHalfAwayFromZero,
  speedMultiplier,
  TEMPO,
  tempoPixelsPerSecond,
} from '@/core'
import type { GridPoint, Heading, PixelRect, Sector, Tempo, WorldEntity } from '@/core'
import { worldMovement } from '@/scene/cameraRig'
import type { ConnectionState, OverlayKind } from './connectionController'
import type { SomnioMessage } from '@/protocol'
import type { WorldRenderSurface } from './renderSurface'
import type { HeldKeys, KeyCaptureSink } from './input'

/**
 * Port of `ClientViewModel.runOneGameplayTick` (`Sources/SomnioApp/ViewModels/ClientViewModel.swift`).
 *
 * The local player moves by client-side prediction at frame rate and reports to the server on a
 * 2 Hz heartbeat; the server trusts the report and relays it. Everything in here therefore has
 * to match the Swift predictor arithmetic exactly, because the *server* re-runs the same
 * feet-box gate: a step this code accepts that the server rejects comes back as a `snapBack` and
 * reads as rubber-banding.
 *
 * Time is injected — `runTick` takes the timestamp rather than reading a clock — so the whole
 * tick is drivable from a test without a frame loop. That is the repo's testable-time
 * convention, and the deterministic tick suite is what it exists for.
 */

/** Upper bound on one tick's elapsed time, so a stall (or the first tick) cannot teleport. */
export const MAX_TICK_ELAPSED_MS = 100
/** Position-broadcast heartbeat (legacy `UpdateTimer`, 2 Hz). */
export const POSITION_HEARTBEAT_INTERVAL_MS = 500
/**
 * A facing change below this shortest-arc threshold does not by itself trigger an emit — a
 * cursor jittering by fractions of a degree (including across the 0/360 seam) would otherwise
 * report on every heartbeat.
 */
export const FACING_EMIT_THRESHOLD_DEGREES = 1
/** Peer interpolation matches the heartbeat so remote players tween rather than step. */
export const PEER_INTERPOLATION_SECONDS = 0.5
/** NPCs and monsters stay on the 50 ms server AI-tick cadence so they don't lag the server. */
export const AI_TICK_INTERPOLATION_SECONDS = 0.05

export interface Velocity {
  dx: number
  dy: number
}

/** Normalized eight-way direction from the held bitset; zero when nothing is held. */
export function velocityFromHeld(held: HeldKeys): Velocity {
  let dx = 0
  let dy = 0
  if (held.d) dx += 1
  if (held.a) dx -= 1
  if (held.w) dy -= 1
  if (held.s) dy += 1
  if (dx === 0 && dy === 0) return { dx: 0, dy: 0 }
  const length = Math.sqrt(dx * dx + dy * dy)
  return { dx: dx / length, dy: dy / length }
}

export function tempoFromHeld(held: HeldKeys): Tempo {
  if (held.leftShift) return TEMPO.run
  if (held.leftOption) return TEMPO.walk
  return TEMPO.default
}

export interface CollisionTriggers {
  bumpedNPC: number | undefined
  portal: number | undefined
}

/**
 * Module-private, as is `collisionTriggers` below: nothing outside this file calls either, and an
 * `export` would suppress `tsc`'s unused-symbol reporting for it — the browser half has no Periphery
 * equivalent to notice. `entityBlockers` stays exported because `predictor.test.ts` drives it
 * directly.
 */
function isBlocked(triggers: CollisionTriggers): boolean {
  return triggers.bumpedNPC !== undefined || triggers.portal !== undefined
}

/**
 * Port of `ClientViewModel.collisionTriggers`. The player's feet box at the attempted next step
 * overlapping an NPC feet box or a portal trigger rect is a hit that both blocks the step and
 * fires the trigger — one unified test for what the legacy client called `KollisionChecken`.
 */
function collisionTriggers(
  playerFeetRect: PixelRect,
  npcFeetRects: readonly { index: number; rect: PixelRect }[],
  triggerRects: readonly { index: number; rect: PixelRect }[]
): CollisionTriggers {
  let bumpedNPC: number | undefined
  for (const npc of npcFeetRects) {
    if (overlaps(playerFeetRect, npc.rect)) {
      bumpedNPC = npc.index
      break
    }
  }
  let portal: number | undefined
  for (const trigger of triggerRects) {
    if (overlaps(playerFeetRect, trigger.rect)) {
      portal = trigger.index
      break
    }
  }
  return { bumpedNPC, portal }
}

/**
 * Port of `ClientViewModel.entityBlockers`. Peers are always solid; monsters are *soft-solid* —
 * a monster the player is clear of blocks the step, but one already overlapping the player's
 * feet box is dropped so the player can always slide free. Monsters move every 50 ms AI tick and
 * can lag onto the player, and a hard block there would trap them with no escape.
 *
 * NPCs are excluded entirely so the slide reaches an NPC's feet box and `collisionTriggers`
 * fires the bump, instead of the move gate stopping one pixel short and never triggering.
 */
export function entityBlockers(
  entities: Iterable<WorldEntity>,
  selfIndex: number,
  playerFeet: PixelRect
): PixelRect[] {
  const blockers: PixelRect[] = []
  for (const entity of entities) {
    if (entity.id === selfIndex || entity.kind === 'npc') continue
    const rect = feetRect(entity.position, entity.maskSize)
    if (entity.kind === 'monster' && overlaps(playerFeet, rect)) continue
    blockers.push(rect)
  }
  return blockers
}

/**
 * Axis-separated feet-box slide. Each axis commits only if the feet box at the candidate clears
 * bounds, static masks, and blockers, so the player glides along a wall instead of sticking.
 * Resolving X first and then testing Y *from the resolved X* is what produces the slide; testing
 * both axes against `from` would let a diagonal step cut a corner.
 */
export function resolvedMove(
  from: GridPoint,
  to: GridPoint,
  sector: Sector,
  blockers: readonly PixelRect[]
): GridPoint {
  const spriteSize = SOMNIO_CONSTANTS.playerSpriteSize
  const resolved = { x: from.x, y: from.y }
  if (isFeetClear({ x: to.x, y: from.y }, spriteSize, sector, blockers)) {
    resolved.x = to.x
  }
  if (isFeetClear({ x: resolved.x, y: to.y }, spriteSize, sector, blockers)) {
    resolved.y = to.y
  }
  return resolved
}

/** The live gameplay state the tick reads. Supplied by the connection controller. */
export interface PredictorSession {
  /**
   * Typed rather than `string`/`unknown`: the whole input gate is two comparisons against these, and
   * a typo or a renamed state would compile clean against a widened type, leaving the gate silently
   * shut and the character unable to move with nothing objecting.
   */
  readonly connectionState: ConnectionState
  readonly presentedOverlay: OverlayKind | undefined
  readonly isChatInputFocused: boolean
  readonly entities: Map<number, WorldEntity>
  readonly selfEntityIndex: number | undefined
  readonly currentSector: Sector | undefined
}

export interface PredictorOptions {
  session: PredictorSession
  input: KeyCaptureSink
  renderSurface: WorldRenderSurface
  send: (message: SomnioMessage) => void
  /** Latest cursor-derived facing, or `undefined` before the pointer has been seen. */
  mouseFacing: () => Heading | undefined
}

export class GameplayPredictor {
  private readonly session: PredictorSession
  private readonly input: KeyCaptureSink
  private readonly renderSurface: WorldRenderSurface
  private readonly send: (message: SomnioMessage) => void
  private readonly mouseFacing: () => Heading | undefined

  private lastTickMs: number | undefined
  private movementRemainder = { dx: 0, dy: 0 }
  private lastEmittedPosition: GridPoint | undefined
  private lastEmittedFacing: Heading | undefined
  private lastEmittedTempo: Tempo | undefined
  private lastEmitMs: number | undefined
  private lastBumpedPortalIndex: number | undefined

  constructor(options: PredictorOptions) {
    this.session = options.session
    this.input = options.input
    this.renderSurface = options.renderSurface
    this.send = options.send
    this.mouseFacing = options.mouseFacing
  }

  /**
   * Clears every per-session slot. Called on a sector hop and on teardown: a carried
   * `movementRemainder` or a stale `lastEmitMs` would otherwise bias the first tick in the new
   * sector, and a stale `lastBumpedPortalIndex` would latch the arrival portal shut.
   */
  reset(): void {
    this.lastTickMs = undefined
    this.movementRemainder = { dx: 0, dy: 0 }
    this.lastEmittedPosition = undefined
    this.lastEmittedFacing = undefined
    this.lastEmittedTempo = undefined
    this.lastEmitMs = undefined
    this.lastBumpedPortalIndex = undefined
  }

  /**
   * A server `snapBack` replaces the predicted position outright, so the fraction carried from
   * the rejected path must not bias the next tick.
   */
  clearMovementRemainder(): void {
    this.movementRemainder = { dx: 0, dy: 0 }
  }

  /** Test seam: the sub-pixel fraction the renderer is drawing at. */
  get _movementRemainder(): { dx: number; dy: number } {
    return { ...this.movementRemainder }
  }

  /**
   * The full gameplay-input gate, refreshed every tick so opening an overlay or focusing chat
   * releases the keys without an explicit notify path.
   *
   * `awaitingEnterSector` still counts as active so held WASD survives a portal hop and motion
   * resumes on arrival — the `selfEntityIndex` guard in `runTick` is what stops movement in the
   * gap, not the gate.
   */
  private gateIsOpen(): boolean {
    const state = this.session.connectionState
    return (
      (state === 'attached' || state === 'awaitingEnterSector') &&
      this.session.presentedOverlay === undefined &&
      !this.session.isChatInputFocused
    )
  }

  runTick(nowMs: number): void {
    // Assigning the gate is what clears held keys when it closes: the sink drops its bitset on
    // deactivation, so an overlay opening mid-hold cannot leave the character walking.
    this.input.setGameplayActive(this.gateIsOpen())
    if (this.session.isChatInputFocused) return
    const selfIndex = this.session.selfEntityIndex
    const sector = this.session.currentSector
    if (selfIndex === undefined || sector === undefined) return
    const existing = this.session.entities.get(selfIndex)
    if (existing === undefined) return

    const selfEntity: WorldEntity = { ...existing }
    const held = this.input.snapshot()
    const tempo = tempoFromHeld(held)

    // Refresh facing every tick regardless of velocity so a stationary player still tracks the
    // cursor — the legacy quadrant rule is independent of movement.
    const facing = this.mouseFacing()
    if (facing !== undefined) selfEntity.facing = facing

    // The lower bound guards a misbehaving injected timestamp; `performance.now()` is monotonic.
    const elapsedMs =
      this.lastTickMs === undefined ? 0 : clamp(nowMs - this.lastTickMs, 0, MAX_TICK_ELAPSED_MS)
    this.lastTickMs = nowMs

    const velocity = velocityFromHeld(held)
    let enteredPortal = false
    // Declared out here so it reaches the unconditional render update below; `undefined` on a
    // stationary tick preserves the renderer's held travel direction.
    let travel: Heading | undefined
    if (velocity.dx !== 0 || velocity.dy !== 0) {
      const world = worldMovement(velocity.dx, velocity.dy)
      // Intended (pre-collision) travel: the multiplier below sizes the pre-resolution step, so
      // a wall-slide keeps clip and speed mutually consistent.
      travel = headingFromVector(world.dx, world.dy)
      const direction = relativeDirection(travel, selfEntity.facing)
      const pixels = tempoPixelsPerSecond(tempo) * (elapsedMs / 1000) * speedMultiplier(direction)
      const exactDX = world.dx * pixels + this.movementRemainder.dx
      const exactDY = world.dy * pixels + this.movementRemainder.dy
      const dxPx = roundHalfAwayFromZero(exactDX)
      const dyPx = roundHalfAwayFromZero(exactDY)
      // Sub-pixel carry: dropping this truncates every tick's fraction and produces a
      // systematic speed deficit that no manual walk reveals.
      this.movementRemainder = { dx: exactDX - dxPx, dy: exactDY - dyPx }
      const intended: GridPoint = {
        x: clampToInt16(selfEntity.position.x + dxPx),
        y: clampToInt16(selfEntity.position.y + dyPx),
      }
      // Clamp to the sector's feet-box bounds so a move toward an edge lands flush against it
      // rather than stopping up to one tick short.
      const target = clampToSector(intended, SOMNIO_CONSTANTS.playerSpriteSize, sector)
      const selfFeet = feetRect(selfEntity.position, SOMNIO_CONSTANTS.playerSpriteSize)
      const blockers = entityBlockers(this.session.entities.values(), selfIndex, selfFeet)
      const candidate = resolvedMove(selfEntity.position, target, sector, blockers)
      // Testing the post-resolution candidate rather than the raw step is what stops a trigger
      // firing through a wall the player cannot actually cross.
      const candidateFeet = feetRect(candidate, SOMNIO_CONSTANTS.playerSpriteSize)
      const triggers = collisionTriggers(candidateFeet, this.npcFeetRects(), portalTriggerRects(sector))
      if (isBlocked(triggers)) {
        this.movementRemainder = { dx: 0, dy: 0 }
      } else {
        // Drop the carried fraction on any axis the clamp or collision cut, so the sub-pixel
        // render position never drifts off the authoritative grid position.
        if (candidate.x !== intended.x) this.movementRemainder.dx = 0
        if (candidate.y !== intended.y) this.movementRemainder.dy = 0
        selfEntity.position = candidate
      }
      enteredPortal = this.dispatchTriggers(triggers)
    }

    selfEntity.tempo = velocity.dx === 0 && velocity.dy === 0 ? TEMPO.default : tempo
    this.session.entities.set(selfIndex, selfEntity)
    this.renderSurface.updateTempo(selfIndex, selfEntity.tempo)
    // Render at the exact sub-pixel position: the integer step of a screen-straight walk
    // alternates between neighbouring world directions tick to tick, which reads as left/right
    // jitter if the renderer only ever sees the rounded grid position.
    this.renderSurface.updateSubpixelPosition(
      selfIndex,
      {
        x: selfEntity.position.x + this.movementRemainder.dx,
        y: selfEntity.position.y + this.movementRemainder.dy,
      },
      selfEntity.facing,
      travel
    )

    // A portal-blocked tick must not also report its now-stale old-sector position: the server
    // processes `enterPortal` first and switches sector, so a trailing `clientPosition` would
    // apply the old coordinates in the new sector and snap the player off the arrival placement.
    if (!enteredPortal) {
      this.emitIfChanged(selfEntity, selfEntity.tempo, nowMs)
    }
  }

  /**
   * Sends the NPC-bump and portal-enter triggers and reports whether a portal fired. The bump is
   * continuous with no latch — the server's `targetingEntity` gate makes repeats no-ops — while
   * the portal is latched so one threshold contact fires a single sector switch.
   */
  private dispatchTriggers(triggers: CollisionTriggers): boolean {
    if (triggers.bumpedNPC !== undefined) {
      this.send({ tag: 'bumpNPC', payload: { npcIndex: triggers.bumpedNPC } })
    }
    if (triggers.portal === undefined) {
      this.lastBumpedPortalIndex = undefined
      return false
    }
    if (triggers.portal !== this.lastBumpedPortalIndex) {
      this.lastBumpedPortalIndex = triggers.portal
      this.send({ tag: 'enterPortal', payload: { portalIndex: triggers.portal } })
    }
    return true
  }

  /**
   * NPC feet boxes paired with their entity index. NPCs are excluded from the movement blocker
   * set so the slide reaches their feet box; this re-introduces them as bump targets.
   */
  private npcFeetRects(): { index: number; rect: PixelRect }[] {
    const rects: { index: number; rect: PixelRect }[] = []
    for (const entity of this.session.entities.values()) {
      if (entity.kind !== 'npc') continue
      rects.push({ index: entity.id, rect: feetRect(entity.position, entity.maskSize) })
    }
    return rects
  }

  /**
   * `nowMs` is the enclosing tick's single timestamp, so the movement step and the heartbeat gate
   * never see two slightly different instants within one tick.
   */
  private emitIfChanged(entity: WorldEntity, tempo: Tempo, nowMs: number): void {
    const facingUnchanged =
      this.lastEmittedFacing !== undefined &&
      Math.abs(angularDistance(this.lastEmittedFacing, entity.facing)) <= FACING_EMIT_THRESHOLD_DEGREES
    if (
      this.lastEmittedPosition !== undefined &&
      this.lastEmittedPosition.x === entity.position.x &&
      this.lastEmittedPosition.y === entity.position.y &&
      facingUnchanged &&
      this.lastEmittedTempo === tempo
    ) {
      return
    }
    // Heartbeat gate. The last-emitted snapshot is deliberately left unchanged when throttled, so
    // the next tick past the interval still sees the move as pending and reports the final
    // position rather than dropping it.
    if (this.lastEmitMs !== undefined && nowMs - this.lastEmitMs < POSITION_HEARTBEAT_INTERVAL_MS) {
      return
    }
    this.lastEmitMs = nowMs
    this.lastEmittedPosition = { ...entity.position }
    this.lastEmittedFacing = entity.facing
    this.lastEmittedTempo = tempo
    this.send({
      tag: 'clientPosition',
      payload: {
        entityIndex: 0,
        x: entity.position.x,
        y: entity.position.y,
        facing: entity.facing,
        tempo,
      },
    })
  }
}
