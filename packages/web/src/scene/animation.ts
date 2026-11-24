import type { AbilityId, RelativeDirection, WorldEntityKind } from '@somnio/core';
import type { Gait } from '@somnio/protocol';

/** Pose selection and clip preference lists. */
export type AnimationPose = 'idle' | 'sneaking' | 'walking' | 'running' | 'backpedal' | 'strafeLeft' | 'strafeRight';

/**
 * Movement clip per gait and travel direction.
 *
 * For players the walk gait reads as sneaking and the run gait as running, but only when moving
 * forward. Backpedalling and strafing collapse to their single directional clip regardless of
 * gait, because no tier-specific variants exist. NPCs amble on the plain walk clip whatever
 * their gait — the librarian must not skulk through its own room — and monsters run on the run
 * gait and walk on any other, so `direction` is ignored for both.
 */
export function movementPose(kind: WorldEntityKind, gait: Gait, direction: RelativeDirection): AnimationPose {
  if (kind === 'npc') return 'walking';
  if (kind === 'monster') return gait === 'run' ? 'running' : 'walking';
  switch (direction) {
    case 'forward':
      return gait === 'walk' ? 'sneaking' : gait === 'run' ? 'running' : 'walking';
    case 'backward':
      return 'backpedal';
    case 'strafeLeft':
      return 'strafeLeft';
    case 'strafeRight':
      return 'strafeRight';
  }
}

/**
 * Clip preference per pose, each falling back toward the forward walk clip and finally
 * `Flying_Idle`. The Ghost has no walk clip. It drifts on `Flying_Idle` and runs on
 * `Fast_Flying`, so every pose has to reach `Flying_Idle` or the drift freezes. Sneak and run
 * fall back to the walk clip because a model in the operator-supplied pack may lack them.
 *
 * There is deliberately **no** playback-rate scaling anywhere: KayKit's clips are cadence-tuned
 * as authored, and a gap tier collapses to the single available clip rather than being
 * time-stretched into it.
 */
export const CLIP_PREFERENCES: Record<AnimationPose, readonly string[]> = {
  idle: ['Idle', 'Flying_Idle'],
  walking: ['Walking_A', 'Flying_Idle'],
  sneaking: ['Sneaking', 'Walking_A', 'Flying_Idle'],
  running: ['Running_A', 'Walking_A', 'Fast_Flying', 'Flying_Idle'],
  backpedal: ['Walking_Backwards', 'Walking_A', 'Flying_Idle'],
  strafeLeft: ['Running_Strafe_Left', 'Walking_A', 'Flying_Idle'],
  strafeRight: ['Running_Strafe_Right', 'Walking_A', 'Flying_Idle'],
};

/** First available clip for a pose, walking the preference chain. */
export function resolveClipName(pose: AnimationPose, available: readonly string[]): string | undefined {
  return CLIP_PREFERENCES[pose].find((name) => available.includes(name));
}

/**
 * Clips that play once, over whatever pose is looping: the fall, which then holds its last frame
 * for as long as the entity lies fallen, a blow given or taken, an item thrown to the ground, an
 * ability used, and a boss's wail and its call to its minions, after which the entity returns to
 * its looping pose.
 *
 * A table of its own rather than more poses: a pose is what an entity is doing and has to reach a
 * clip on every model, while a one-shot is an event and has no fallback. A model with none of its
 * clips keeps its looping pose.
 */
export type OneShot = 'fallen' | 'swing' | 'flinch' | 'throw' | 'wail' | 'summon' | AbilityId;

export const ONE_SHOT_CLIPS: Record<OneShot, readonly string[]> = {
  fallen: ['Death_A', 'Death'],
  swing: ['Melee_1H_Attack_Slice_Horizontal', 'Punch'],
  flinch: ['Hit_A', 'HitReact'],
  throw: ['Throw'],
  wail: ['Ranged_Magic_Spellcasting_Long'],
  summon: ['Ranged_Magic_Summon'],
  cleave: ['Melee_1H_Attack_Slice_Horizontal'],
  challenge: ['Ranged_Magic_Raise'],
  brace: ['Melee_Block'],
  lunge: ['Melee_1H_Attack_Jump_Chop'],
  rally: ['Cheering'],
  'deep-mend': ['Ranged_Magic_Spellcasting_Long'],
  renewal: ['Ranged_Magic_Shoot'],
  radiance: ['Ranged_Magic_Raise'],
  calm: ['Ranged_Magic_Spellcasting'],
  ward: ['Ranged_Magic_Shoot'],
  weaken: ['Ranged_Magic_Spellcasting'],
  bind: ['Ranged_Magic_Spellcasting'],
  'dream-bolt': ['Ranged_Magic_Shoot'],
  veil: ['Ranged_Magic_Raise'],
};

export function resolveOneShotClipName(oneShot: OneShot, available: readonly string[]): string | undefined {
  return ONE_SHOT_CLIPS[oneShot].find((name) => available.includes(name));
}

/** An entity counts as moving for this long after its last position change. */
export const MOTION_GRACE_WINDOW = 0.15;

/** Upper bound on one frame's dt so a stall cannot jump the walk clock or the height easing. */
export const MAX_TICK_DELTA = 0.1;

export const CLIP_TRANSITION_DURATION = 0.2;
