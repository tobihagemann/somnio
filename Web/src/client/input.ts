import { headingFromVector } from '@/core'
import type { Heading } from '@/core'
import { applyScrollZoom, worldMovement } from '@/scene/cameraRig'

/**
 * Port of `Sources/SomnioApp/Input/KeyboardSampler.swift` and `MouseFacingSampler.swift`.
 *
 * The browser makes one thing easier than AppKit did: `KeyboardEvent.code` names the *physical*
 * key, so `ShiftLeft` and `AltLeft` are directly observable. The native sampler had to read
 * device-specific `NSEvent` bitmasks to get the same per-side state, because AppKit's `.shift` and
 * `.option` flags are either-side aggregates. Same rule, cheaper mechanism — the legacy left-side
 * tempo convention (LShift runs, LOption walks) is preserved.
 */

export interface HeldKeys {
  w: boolean
  a: boolean
  s: boolean
  d: boolean
  leftShift: boolean
  leftOption: boolean
}

export function noHeldKeys(): HeldKeys {
  return { w: false, a: false, s: false, d: false, leftShift: false, leftOption: false }
}

/**
 * The slice of the sampler the prediction tick drives. Narrow on purpose: the tick both reads the
 * bitset and pushes the gate down, and nothing else, so a test can substitute a plain object.
 */
export interface KeyCaptureSink {
  snapshot(): HeldKeys
  setGameplayActive(active: boolean): void
}

/** Physical key codes that drive the four direction bits. Arrows mirror WASD. */
const DIRECTION_CODES: Record<string, keyof HeldKeys> = {
  KeyW: 'w',
  KeyA: 'a',
  KeyS: 's',
  KeyD: 'd',
  ArrowUp: 'w',
  ArrowLeft: 'a',
  ArrowDown: 's',
  ArrowRight: 'd',
}

const MODIFIER_CODES: Record<string, keyof HeldKeys> = {
  ShiftLeft: 'leftShift',
  AltLeft: 'leftOption',
}

export interface KeyboardSamplerTarget {
  addEventListener(type: string, listener: (event: Event) => void): void
  removeEventListener(type: string, listener: (event: Event) => void): void
}

export class KeyboardSampler implements KeyCaptureSink {
  private held = noHeldKeys()
  private gameplayActive = false
  private started = false
  private readonly target: KeyboardSamplerTarget
  private readonly onKeyDown = (event: Event) => this.handleKey(event as KeyboardEvent, true)
  private readonly onKeyUp = (event: Event) => this.handleKey(event as KeyboardEvent, false)
  private readonly onBlur = () => this.clearHeldKeys()

  constructor(target: KeyboardSamplerTarget = window) {
    this.target = target
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.target.addEventListener('keydown', this.onKeyDown)
    this.target.addEventListener('keyup', this.onKeyUp)
    // A user who holds W and switches windows never gets the matching keyup, so without this the
    // character walks on return. Same failure the visibility handler covers for tab switches.
    this.target.addEventListener('blur', this.onBlur)
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.target.removeEventListener('keydown', this.onKeyDown)
    this.target.removeEventListener('keyup', this.onKeyUp)
    this.target.removeEventListener('blur', this.onBlur)
    this.clearHeldKeys()
  }

  /** Test seam mirroring `_isStarted`, so lifecycle tests need no real event target. */
  get _isStarted(): boolean {
    return this.started
  }

  snapshot(): HeldKeys {
    return { ...this.held }
  }

  /**
   * Releasing capture mid-hold means the matching keyup is never consumed, so the bitset is
   * dropped to avoid phantom movement when gameplay resumes.
   */
  setGameplayActive(active: boolean): void {
    if (this.gameplayActive === active) return
    this.gameplayActive = active
    if (!active) this.clearHeldKeys()
  }

  clearHeldKeys(): void {
    this.held = noHeldKeys()
  }

  /**
   * Whether an event is swallowed for gameplay. Bare direction keys and the tempo modifiers are
   * consumed while gameplay is active, but Meta/Control combos pass through so browser and menu
   * shortcuts still work.
   */
  shouldConsume(event: KeyboardEvent): boolean {
    if (!this.gameplayActive) return false
    if (event.metaKey || event.ctrlKey) return false
    return event.code in DIRECTION_CODES
  }

  private handleKey(event: KeyboardEvent, down: boolean): void {
    // Modifiers track unconditionally: they are never consumed, and a tempo key released while
    // gameplay is inactive must still clear or the character keeps running.
    const modifier = MODIFIER_CODES[event.code]
    if (modifier !== undefined) {
      this.held = { ...this.held, [modifier]: down }
      return
    }
    const direction = DIRECTION_CODES[event.code]
    if (direction === undefined) return
    if (down) {
      // Gate only the *press*. A key pressed bare and released under Meta must still clear its
      // bit, or the key sticks on — the same asymmetry the native sampler documents.
      if (!this.shouldConsume(event)) return
      this.held = { ...this.held, [direction]: true }
    } else {
      this.held = { ...this.held, [direction]: false }
    }
    if (this.shouldConsume(event)) event.preventDefault()
  }
}

/**
 * Maps the cursor's offset from the play-field centre to a continuous heading in world floor
 * axes. The screen offset is rotated through the camera's fixed yaw — the same mapping WASD uses
 * — so the character faces where the cursor sits on screen rather than 35 degrees beside it.
 *
 * Unlike the AppKit original there is no Y flip: DOM pointer coordinates already grow downward,
 * which is the direction `worldMovement` expects.
 */
export function mouseFacingHeading(
  pointer: { x: number; y: number },
  center: { x: number; y: number }
): Heading {
  const world = worldMovement(pointer.x - center.x, pointer.y - center.y)
  return headingFromVector(world.dx, world.dy)
}

/**
 * Session-only scroll zoom, mirroring `PlayerZoom`. Holds the factor rather than the camera scale
 * so the clamp lives at the same place it does natively.
 */
export class PlayerZoom {
  private currentFactor = 1

  get factor(): number {
    return this.currentFactor
  }

  /** Reports whether the factor actually moved, so a caller can let a clamped event pass. */
  applyScroll(deltaY: number): boolean {
    const previous = this.currentFactor
    this.currentFactor = applyScrollZoom(previous, deltaY)
    return this.currentFactor !== previous
  }
}
