import { angularDistance } from './heading'
import type { Heading } from './heading'

/**
 * Mirror of `Sources/SomnioCore/Models/Tempo.swift`. The raw values are the wire encoding, and
 * the speeds deliberately diverge from the legacy presets so sneak and run read believably
 * against the KayKit clips.
 */
export const TEMPO = { walk: 1, default: 2, run: 4 } as const
export type Tempo = (typeof TEMPO)[keyof typeof TEMPO]

const PIXELS_PER_SECOND: Record<Tempo, number> = { 1: 50, 2: 100, 4: 150 }

export function tempoPixelsPerSecond(tempo: Tempo): number {
  return PIXELS_PER_SECOND[tempo]
}

/** Whether a raw wire value names a real tempo case. */
function isTempo(raw: number): raw is Tempo {
  return raw === 1 || raw === 2 || raw === 4
}

/**
 * Wire `tempo` for a **newly created** entity: an unknown value falls back to `.default`, matching
 * `ClientViewModel.handleEntity`.
 */
export function tempoFromRaw(raw: number): Tempo {
  return isTempo(raw) ? raw : TEMPO.default
}

/**
 * Wire `tempo` for a **position update**: an unknown value keeps the entity's current tempo, matching
 * `ClientViewModel.handleServerPosition`'s `Tempo(rawValue:) ?? entity.tempo`.
 *
 * The two fallbacks differ deliberately. On creation there is no prior tempo to keep; on an update
 * there is, and resetting to walking speed mid-stride would desynchronise the clip and the movement
 * from what every other client shows.
 */
export function tempoFromRawOrKeep(raw: number, current: Tempo): Tempo {
  return isTempo(raw) ? raw : current
}

/**
 * Mirror of `Sources/SomnioCore/Models/RelativeDirection.swift`. A single value drives both the
 * movement clip and the speed penalty, so the clip you see and the speed you move at can never
 * disagree.
 */
export type RelativeDirection = 'forward' | 'backward' | 'strafeLeft' | 'strafeRight'

/**
 * Buckets the signed travel-vs-facing angle: within 45 degrees of facing is forward, beyond 135
 * is backward, and the quarter between is a strafe side. 45 is owned by forward and 135 by
 * strafe.
 */
export function relativeDirection(travel: Heading, facing: Heading): RelativeDirection {
  const signed = angularDistance(facing, travel)
  const magnitude = Math.abs(signed)
  if (magnitude <= 45) return 'forward'
  if (magnitude > 135) return 'backward'
  // Sign-to-side mapping pinned by smoke observation: facing the camera (south), a step to
  // screen-east is the character's own left.
  return signed > 0 ? 'strafeLeft' : 'strafeRight'
}

const SPEED_MULTIPLIERS: Record<RelativeDirection, number> = {
  forward: 1.0,
  backward: 0.5,
  strafeLeft: 0.7,
  strafeRight: 0.7,
}

/** Fraction of the same tempo tier's forward speed to travel at. */
export function speedMultiplier(direction: RelativeDirection): number {
  return SPEED_MULTIPLIERS[direction]
}
