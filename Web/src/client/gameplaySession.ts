import { PROTOCOL_BYTE_CAPS, WIRE_HAND, assertNever, truncateToUTF8Bytes } from '@/protocol'
import type { Energy, SomnioMessage, WireHand, WireInventoryRow } from '@/protocol'
import { heading, tempoFromRawOrKeep } from '@/core'
import type { Heading } from '@/core'
import { bubbleLifetimeMs, canvasWidthMeasurer, wrapSpeech } from '@/scene/speechBubbleText'
import { wheelDeltaToNativeScale } from '@/scene/cameraRig'
import type { ConnectionController, GameplayMessage } from './connectionController'
import { AI_TICK_INTERPOLATION_SECONDS, GameplayPredictor, PEER_INTERPOLATION_SECONDS } from './predictor'
import { KeyboardSampler, PlayerZoom, mouseFacingHeading } from './input'
import type { KeyCaptureSink } from './input'

/**
 * The gameplay half of the ported `ClientViewModel`: it owns the predictor, the input samplers,
 * and every inbound frame that is not authentication or session management.
 *
 * The split is explicit rather than implied. `ConnectionController` handles `hello`, the login and
 * register results, and the two session-token frames; everything else lands here. Leaving that
 * boundary implicit is how a tag ends up owned by neither half — which the exhaustive switch below
 * and the controller's own `assertNever` guard together make impossible.
 */

/** Port of `InventoryRow`, resolved from the wire row. */
export interface InventoryRow {
  slot: number
  category: number
  itemId: number
  extras: { key: string; value: number }[]
  /** `undefined` when unequipped; see `HAND` for the two equipped values. */
  equippedHand: Hand | undefined
}

/**
 * Client-level hand, the ported `Hand`. Distinct from `WIRE_HAND` by one: the wire reserves 0 for
 * "no hand" while unequipped is `undefined` here, so the two must never be compared directly.
 */
export const HAND = { left: 0, right: 1 } as const
export type Hand = (typeof HAND)[keyof typeof HAND]

/** Extra key carrying the purse's coin balance. A typo here would silently read 0. */
const GOLD_KEY = 'gold'

export function inventoryRowFromWire(row: WireInventoryRow): InventoryRow {
  return {
    slot: row.slot,
    category: row.category,
    itemId: row.itemId,
    extras: row.extras.map((extra) => ({ key: extra.key, value: extra.value })),
    equippedHand: handFromWire(row.equippedHand),
  }
}

/**
 * Wire 0 means "no hand"; 1 and 2 shift down onto `HAND`'s left/right.
 *
 * A `switch` rather than a ternary chain, so the compiler refuses an unhandled wire value instead of
 * mapping it to `undefined` — which reads as "unequipped" and would silently hide a newly added
 * hand. `WireConversions.swift` switches over all three cases for the same reason.
 */
function handFromWire(wire: WireHand): Hand | undefined {
  switch (wire) {
    case WIRE_HAND.none:
      return undefined
    case WIRE_HAND.left:
      return HAND.left
    case WIRE_HAND.right:
      return HAND.right
    default:
      return assertNever(wire, 'wire hand')
  }
}

export function goldBalance(row: InventoryRow): number {
  return row.extras.find((extra) => extra.key === GOLD_KEY)?.value ?? 0
}

export const ZERO_ENERGY: Energy = {
  hpCurrent: 0,
  hpMax: 1,
  balanceCurrent: 0,
  balanceMax: 1,
  manaCurrent: 0,
  manaMax: 1,
}

export interface GameplaySessionOptions {
  controller: ConnectionController
  send: (message: SomnioMessage) => void
  /** Overridable so headless tests drive the tick without a keyboard or a DOM. */
  input?: KeyCaptureSink & { clearHeldKeys(): void }
  /**
   * Text measurer for speech-bubble wrapping. Defaults to the canvas measurer, which the wrap
   * must agree with or lines overflow the balloon; injectable so a headless test needs no canvas.
   */
  measureText?: (line: string) => number
}

export class GameplaySession {
  readonly predictor: GameplayPredictor
  readonly zoom = new PlayerZoom()
  readonly input: KeyCaptureSink & { clearHeldKeys(): void }

  energy: Energy = ZERO_ENERGY
  inventory: InventoryRow[] = []

  private readonly controller: ConnectionController
  private readonly send: (message: SomnioMessage) => void
  private readonly measureText: (line: string) => number
  private latestMouseFacing: Heading | undefined

  constructor(options: GameplaySessionOptions) {
    this.controller = options.controller
    this.send = options.send
    this.input = options.input ?? new KeyboardSampler()
    this.measureText = options.measureText ?? canvasWidthMeasurer()
    this.predictor = new GameplayPredictor({
      session: this.controller,
      input: this.input,
      renderSurface: this.controller.renderSurface,
      send: this.send,
      mouseFacing: () => this.latestMouseFacing,
    })

    this.controller.onGameplayMessage = (message) => this.dispatch(message)
    // The controller owns the two predicates the gate reads, so it is also what reports the gate
    // closing. Clearing held keys there rather than in each DOM handler is what keeps a stale
    // held bit from resuming movement when focus returns.
    this.controller.onGateClosed = () => this.input.clearHeldKeys()
    this.controller.onSectorChanged = () => {
      this.predictor.reset()
      this.latestMouseFacing = undefined
    }
    this.controller.onTeardown = () => {
      this.predictor.reset()
      this.input.clearHeldKeys()
      this.energy = ZERO_ENERGY
      this.inventory = []
    }
  }

  /** The per-frame body. Injected timestamp, so a test drives it directly. */
  runTick(timestampMs: number): void {
    this.predictor.runTick(timestampMs)
  }

  /**
   * Clears input state that a `keyup` delivered while the page was hidden would have left
   * populated, and drops the tick clock so the first tick back measures zero elapsed rather than
   * the whole hidden interval. The clamp already bounds that interval, but resetting is what makes
   * the resumed tick behave identically to the first tick of a session.
   */
  handleVisibilityLoss(): void {
    this.input.clearHeldKeys()
    this.predictor.reset()
  }

  // MARK: - Input

  updateMouseFacing(pointer: { x: number; y: number }, center: { x: number; y: number }): void {
    this.latestMouseFacing = mouseFacingHeading(pointer, center)
  }

  /**
   * Applies one wheel event.
   *
   * Both the sign and the *scale* have to be converted. Negated because the DOM's positive `deltaY`
   * scrolls down while AppKit's positive `scrollingDeltaY` scrolls up; rescaled because a DOM pixel
   * delta is ~30x an AppKit one, and `PlayerZoom`'s gain is tuned against the latter. `deltaMode`
   * matters too — Firefox reports lines where Chrome reports pixels.
   */
  applyScrollZoom(deltaY: number, deltaMode = 0): boolean {
    return this.zoom.applyScroll(-wheelDeltaToNativeScale(deltaY, deltaMode))
  }

  // MARK: - Outbound gameplay commands

  /**
   * Sends a chat line. The text is capped in **UTF-8 bytes**, not code units: the server rejects
   * on byte length, so a string of 200 emoji passes a `.length <= 256` check and is then refused.
   */
  submitChat(rawText: string): void {
    const text = truncateToUTF8Bytes(rawText.trim(), PROTOCOL_BYTE_CAPS.say)
    const selfIndex = this.controller.selfEntityIndex
    if (text.length === 0 || this.controller.connectionState !== 'attached' || selfIndex === undefined) {
      return
    }
    this.send({ tag: 'clientSay', payload: { entityIndex: 0, text } })
    this.controller.appendChat({
      kind: 'spokenByOwn',
      senderName: this.controller.selfDisplayName,
      message: text,
    })
    const lines = wrapSpeech(text, this.measureText)
    this.controller.renderSurface.showSpeechBubble(selfIndex, lines, bubbleLifetimeMs(lines.length))
  }

  /**
   * Double-click activation. The cudgel toggles equip in its fixed hand — the player never picks
   * one — and the purse reports its balance to the chat log rather than equipping.
   */
  activateInventoryRow(row: InventoryRow): void {
    if (this.controller.connectionState !== 'attached') return
    if (row.category === 0 && row.itemId === 0) {
      this.controller.appendChat({ kind: 'purseBalance', coins: goldBalance(row) })
      return
    }
    if (row.category === 1 && row.itemId === 0) {
      // Re-toggling sends the "no hand" value to unequip; the server clears whatever else held it.
      const hand = row.equippedHand === undefined ? WIRE_HAND.right : WIRE_HAND.none
      this.send({ tag: 'equipToggle', payload: { slot: row.slot, hand } })
    }
  }

  // MARK: - Inbound gameplay dispatch

  private dispatch(message: GameplayMessage): void {
    switch (message.tag) {
      case 'serverPosition':
        this.handleServerPosition(message.payload)
        return
      case 'serverSay':
        this.handleServerSay(message.payload.entityIndex, message.payload.text)
        return
      case 'energy':
        this.energy = message.payload
        this.onStateChanged?.()
        return
      case 'inventory':
        this.inventory = message.payload.rows.map(inventoryRowFromWire)
        this.onStateChanged?.()
        return
      case 'adminSay':
        this.controller.appendChat({ kind: 'adminBroadcast', message: message.payload.text })
        return
      default:
        // Exhaustive over `GameplayMessage`, so a tag added to that union without a case here is a
        // compile error rather than a silently dropped frame.
        assertNever(message, 'gameplay dispatch')
    }
  }

  onStateChanged: (() => void) | undefined

  /**
   * A server position for **self** is a `snapBack` — an authoritative correction after a rejected
   * move — and is the only self-position the protocol ever volunteers. It replaces the prediction
   * outright, which is why the sub-pixel carry has to be dropped: keeping it would re-bias the
   * next tick toward the path the server just refused.
   */
  private handleServerPosition(payload: {
    entityIndex: number
    x: number
    y: number
    facing: number
    tempo: number
  }): void {
    const entity = this.controller.entities.get(payload.entityIndex)
    if (entity === undefined) return
    const position = { x: payload.x, y: payload.y }
    const facing = heading(payload.facing)
    // An unrecognized raw value keeps the entity's *current* tempo, not the default —
    // `ClientViewModel.handleServerPosition` is `Tempo(rawValue:) ?? entity.tempo` on this path,
    // while the default fallback belongs to entity creation (`ClientViewModel.handleEntity`).
    // Resetting here would make the browser and the native client animate the same frame
    // differently.
    const tempo = tempoFromRawOrKeep(payload.tempo, entity.tempo)
    this.controller.entities.set(payload.entityIndex, { ...entity, position, facing, tempo })
    this.controller.renderSurface.updateTempo(payload.entityIndex, tempo)
    if (entity.kind === 'player') {
      this.predictor.clearMovementRemainder()
      // A direct set, not a tween: the predictor writes this node every frame and also drives the
      // camera, so an interpolation would fight it and de-centre the view.
      this.controller.renderSurface.updatePosition(payload.entityIndex, position, facing)
      return
    }
    // Peers arrive on the ~500 ms heartbeat and NPCs/monsters on the 50 ms AI tick, so each tweens
    // across its own gap rather than stepping or lagging.
    const duration = entity.kind === 'peer' ? PEER_INTERPOLATION_SECONDS : AI_TICK_INTERPOLATION_SECONDS
    this.controller.renderSurface.animateEntity(payload.entityIndex, position, facing, duration)
  }

  /** NPC dialog arrives here, not on a dedicated tag — there is no NPC-dialog verb. */
  private handleServerSay(entityIndex: number, text: string): void {
    const entity = this.controller.entities.get(entityIndex)
    if (entity === undefined) return
    const kind = entity.kind === 'npc' || entity.kind === 'monster' ? 'spokenByNPC' : 'spokenByPeer'
    this.controller.appendChat({ kind, senderName: entity.name, message: text })
    const lines = wrapSpeech(text, this.measureText)
    this.controller.renderSurface.showSpeechBubble(entityIndex, lines, bubbleLifetimeMs(lines.length))
  }
}
