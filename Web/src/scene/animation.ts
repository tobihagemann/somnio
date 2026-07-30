import type { RelativeDirection, Tempo } from '@/core/tempo'
import type { WorldEntityKind } from '@/core/worldEntity'

/**
 * Mirror of `WorldScene3D`'s pose selection and clip preference lists.
 */
export type AnimationPose =
  'idle' | 'sneaking' | 'walking' | 'running' | 'backpedal' | 'strafeLeft' | 'strafeRight'

/**
 * Movement clip per tempo and travel direction.
 *
 * The Option-slow tempo reads as sneaking and the Shift tempo as running, but only when moving
 * forward and only for player-kind figures. Backpedalling and strafing collapse to their single
 * directional clip regardless of tempo, because no tier-specific variants exist. NPCs amble on
 * the plain walk clip — the librarian must not skulk through its own room — and monsters drift
 * on their single clip, so `direction` is ignored for both.
 */
export function movementPose(
  kind: WorldEntityKind,
  tempo: Tempo,
  direction: RelativeDirection
): AnimationPose {
  if (kind === 'npc' || kind === 'monster') return 'walking'
  switch (direction) {
    case 'forward':
      return tempo === 1 ? 'sneaking' : tempo === 4 ? 'running' : 'walking'
    case 'backward':
      return 'backpedal'
    case 'strafeLeft':
      return 'strafeLeft'
    case 'strafeRight':
      return 'strafeRight'
  }
}

/**
 * Clip preference per pose, each falling back toward the forward walk clip and finally
 * `Flying_Idle`. The Ghost carries only `Flying_Idle`, so every pose has to reach it or the
 * drift freezes; sneak and run fall back to the walk clip for models converted before those
 * clips were merged in.
 *
 * There is deliberately **no** playback-rate scaling anywhere: KayKit's clips are cadence-tuned
 * as authored, and a gap tier collapses to the single available clip rather than being
 * time-stretched into it.
 */
export const CLIP_PREFERENCES: Record<AnimationPose, readonly string[]> = {
  idle: ['Idle', 'Flying_Idle'],
  walking: ['Walking_A', 'Flying_Idle'],
  sneaking: ['Sneaking', 'Walking_A', 'Flying_Idle'],
  running: ['Running_A', 'Walking_A', 'Flying_Idle'],
  backpedal: ['Walking_Backwards', 'Walking_A', 'Flying_Idle'],
  strafeLeft: ['Running_Strafe_Left', 'Walking_A', 'Flying_Idle'],
  strafeRight: ['Running_Strafe_Right', 'Walking_A', 'Flying_Idle'],
}

/** First available clip for a pose, walking the preference chain. */
export function resolveClipName(pose: AnimationPose, available: readonly string[]): string | undefined {
  return CLIP_PREFERENCES[pose].find((name) => available.includes(name))
}

/** An entity counts as moving for this long after its last position change. */
export const MOTION_GRACE_WINDOW = 0.15

/** Upper bound on one frame's dt so a stall cannot teleport tweens or the walk clock. */
export const MAX_TICK_DELTA = 0.1

export const CLIP_TRANSITION_DURATION = 0.2
