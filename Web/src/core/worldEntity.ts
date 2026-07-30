import { clampToInt16 } from './geometry'
import type { GridPoint, GridSize } from './geometry'
import type { Heading } from './heading'
import type { Tempo } from './tempo'

/**
 * Mirror of `WorldEntity`. Rebuilt from every inbound `entity` frame, so it carries no
 * per-frame render state — the walk clocks and slewed yaw live in the scene, keyed by entity
 * index, exactly as they do in the native renderer.
 */
export type WorldEntityKind = 'player' | 'peer' | 'npc' | 'monster'

export interface WorldEntity {
  id: number
  kind: WorldEntityKind
  figure: number
  gender: number
  position: GridPoint
  facing: Heading
  tempo: Tempo
  maskSize: GridSize
  name: string
}

/** Sub-pixel position on the legacy pixel grid, mirroring `SubpixelPoint`. */
export interface SubpixelPoint {
  x: number
  y: number
}

/** The one rule for collapsing a sub-pixel render position back onto the simulation grid. */
export function gridRounded(point: SubpixelPoint): GridPoint {
  return { x: clampRound(point.x), y: clampRound(point.y) }
}

/**
 * Swift's `rounded()` followed by `Int16(clamping:)`.
 *
 * Exported because it is the one rule for the half-away-from-zero convention: `Math.round` rounds
 * half toward +infinity, so a negative .5 lands on the wrong neighbour, and every site that
 * collapses a sub-pixel coordinate has to agree. The bound goes through `clampToInt16` rather than
 * restating the Int16 range.
 */
export function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value)
}

function clampRound(value: number): number {
  return clampToInt16(roundHalfAwayFromZero(value))
}
