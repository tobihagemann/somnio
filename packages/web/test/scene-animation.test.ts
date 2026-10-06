import { describe, expect, it } from 'vitest';
import { GAITS } from '@somnio/protocol';
import { CLIP_PREFERENCES, ONE_SHOT_CLIPS, movementPose, resolveClipName, resolveOneShotClipName } from '@/scene/animation';
import { worldMovement } from '@/scene/cameraRig';
import { sunState } from '@/scene/dayNightSun';
import { BUBBLE_WIDTH, bubbleLifetimeMs, capLines, wrapSpeech } from '@/scene/speechBubbleText';

describe('movementPose', () => {
  it.each([
    ['walk', 'forward', 'sneaking'],
    ['jog', 'forward', 'walking'],
    ['run', 'forward', 'running'],
  ] as const)('player at a %s moving %s uses %s', (gait, direction, pose) => {
    expect(movementPose('player', gait, direction)).toBe(pose);
  });

  /** No tier-specific backpedal or strafe clips exist, so those collapse regardless of gait. */
  it.each(GAITS)('backpedal collapses to one clip at a %s', (gait) => {
    expect(movementPose('player', gait, 'backward')).toBe('backpedal');
  });

  it.each(GAITS)('strafing collapses to one clip per side at a %s', (gait) => {
    expect(movementPose('player', gait, 'strafeLeft')).toBe('strafeLeft');
    expect(movementPose('player', gait, 'strafeRight')).toBe('strafeRight');
  });

  it('shares the player pose set with peers', () => {
    expect(movementPose('peer', 'run', 'forward')).toBe('running');
  });

  /** The librarian must not skulk through its own room, so NPCs ignore gait and direction. */
  it.each([
    ['npc', 'walk', 'backward'],
    ['npc', 'run', 'forward'],
    ['monster', 'run', 'strafeLeft'],
  ] as const)('%s at a %s moving %s always walks', (kind, gait, direction) => {
    expect(movementPose(kind, gait, direction)).toBe('walking');
  });
});

describe('clip preference chains', () => {
  it('prefers the exact clip when present', () => {
    expect(resolveClipName('running', ['Idle', 'Walking_A', 'Running_A'])).toBe('Running_A');
  });

  it('falls back to the walk clip for a model converted before the tier existed', () => {
    expect(resolveClipName('sneaking', ['Idle', 'Walking_A'])).toBe('Walking_A');
    expect(resolveClipName('strafeLeft', ['Idle', 'Walking_A'])).toBe('Walking_A');
  });

  /**
   * The Ghost carries only `Flying_Idle`, so every pose has to reach it — otherwise its drift
   * freezes on any pose whose chain runs out.
   */
  it.each(Object.keys(CLIP_PREFERENCES) as (keyof typeof CLIP_PREFERENCES)[])('pose %s reaches Flying_Idle for a ghost-like model', (pose) => {
    expect(resolveClipName(pose, ['Flying_Idle'])).toBe('Flying_Idle');
  });

  it('resolves nothing when the model has no usable clip', () => {
    expect(resolveClipName('idle', ['Unrelated'])).toBeUndefined();
  });
});

describe('one-shot clips', () => {
  /** What the player's model and the Gespenst carry, as the registry expects of each. */
  const WACHEN = ['Idle', 'Walking_A', 'Death_A', 'Hit_A', 'Interact'];
  const GESPENST = ['Flying_Idle', 'Death', 'HitReact', 'Punch'];

  it.each([
    ['fallen', 'Death_A', 'Death'],
    ['swing', 'Interact', 'Punch'],
    ['flinch', 'Hit_A', 'HitReact'],
  ] as const)('resolves %s to %s on a dreamer and %s on a Gespenst', (oneShot, dreamer, ghost) => {
    expect(resolveOneShotClipName(oneShot, WACHEN)).toBe(dreamer);
    expect(resolveOneShotClipName(oneShot, GESPENST)).toBe(ghost);
  });

  /** An event has no fallback: a model without the clip keeps the pose it is looping. */
  it.each(Object.keys(ONE_SHOT_CLIPS) as (keyof typeof ONE_SHOT_CLIPS)[])('resolves nothing for %s on a model that carries only looping clips', (oneShot) => {
    expect(resolveOneShotClipName(oneShot, ['Idle', 'Walking_A', 'Flying_Idle'])).toBeUndefined();
  });
});

/** `fullAmbientIntensity` and `fullSunIntensity`, the levels a fully lit outdoor scene reaches. */
const FULL_AMBIENT = 1200;
const FULL_SUN = 6000;

describe('outdoor ambient', () => {
  it('holds full brightness from mid-morning to early evening', () => {
    for (const hour of [10, 12.5, 17.99, 18]) expect(sunState(hour, undefined).ambientIntensity).toBeCloseTo(FULL_AMBIENT, 9);
  });

  /** Night floors dim rather than black: the ramp is pulled a quarter of the way toward full. */
  it('floors the night at just over a quarter', () => {
    for (const hour of [0, 3, 5.99, 22, 23.99]) expect(sunState(hour, undefined).ambientIntensity).toBeCloseTo(0.2575 * FULL_AMBIENT, 6);
  });

  it.each([
    [7, 0.4375],
    [8, 0.625],
    [9, 0.8125],
    [19, 0.8125],
    [20, 0.625],
    [21, 0.4375],
  ])('passes through the anchor at %s:00', (hour, level) => {
    expect(sunState(hour, undefined).ambientIntensity).toBeCloseTo(level * FULL_AMBIENT, 9);
  });

  /** A ramp, not a staircase: any minute sits on the straight line between its hour's two anchors. */
  it('interpolates linearly between two anchors, with no steps inside the hour', () => {
    const at = (hour: number): number => sunState(hour, undefined).ambientIntensity;

    for (const minute of [1, 11, 12, 30, 47, 59]) {
      const fraction = minute / 60;
      expect(at(7 + fraction)).toBeCloseTo(at(7) + (at(8) - at(7)) * fraction, 9);
      expect(at(19 + fraction)).toBeCloseTo(at(19) + (at(20) - at(19)) * fraction, 9);
    }
  });

  it('mirrors the morning rise in the evening fall', () => {
    for (const hours of [0.25, 1, 2.6, 3.9]) {
      expect(sunState(22 - hours, undefined).ambientIntensity).toBeCloseTo(sunState(6 + hours, undefined).ambientIntensity, 9);
    }
  });
});

describe('sun state', () => {
  it('uses the fixed interior key with no arc', () => {
    const interior = sunState(12, 100);
    const midnightInterior = sunState(0, 100);
    expect(interior).toEqual(midnightInterior);
    expect(interior.sunColor).toEqual({ r: 1, g: 1, b: 1 });
  });

  it('scales interior intensity by the authored brightness', () => {
    const bright = sunState(12, 100);
    const dim = sunState(12, 50);
    expect(dim.sunIntensity).toBeCloseTo(bright.sunIntensity / 2, 9);
    expect(dim.ambientIntensity).toBeCloseTo(bright.ambientIntensity / 2, 9);
    // Half of the interior's share of each full level: 0.8 of the sun, 0.65 of the ambient.
    expect(dim.sunIntensity).toBeCloseTo(0.5 * 0.8 * FULL_SUN, 9);
    expect(dim.ambientIntensity).toBeCloseTo(0.5 * 0.65 * FULL_AMBIENT, 9);
  });

  it('holds the sun on or above the horizon through the whole day arc', () => {
    // Elevation is `sin(progress * pi)`, so it is exactly 0 at sunrise — the sun sits *on* the
    // horizon at 06:00 and climbs from there.
    expect(sunState(6, undefined).direction.y).toBe(0);
    for (let hour = 6.25; hour < 22; hour += 0.25) {
      expect(sunState(hour, undefined).direction.y).toBeGreaterThan(0);
    }
  });

  /** Peak elevation stays below 90 degrees so shadows always have a direction to fall in. */
  it('never puts the sun directly overhead', () => {
    for (let hour = 6; hour < 22; hour += 0.25) {
      expect(sunState(hour, undefined).direction.y).toBeLessThan(0.95);
    }
  });

  it('rises east of south and sets west of it', () => {
    for (const hour of [7, 20]) expect(sunState(hour, undefined).direction.z).toBeGreaterThan(0);
    expect(sunState(7, undefined).direction.x).toBeGreaterThan(0);
    expect(sunState(20, undefined).direction.x).toBeLessThan(0);
  });

  /**
   * The camera hides the ground behind a caster for as far as the caster is tall, so a shadow that
   * falls straight away from the camera is cast and never seen. What shows is how far the shadow
   * lands to one side, across the screen; the interior key throws it 0.49 of the caster's height.
   */
  it('throws every daylight shadow to one side of its caster as the camera sees it', () => {
    const right = worldMovement(1, 0);
    for (let hour = 6.5; hour <= 21.5; hour += 0.25) {
      const { direction } = sunState(hour, undefined);
      const sideways = Math.abs(direction.x * right.dx + direction.z * right.dz) / direction.y;
      expect(sideways).toBeGreaterThan(0.4);
    }
  });

  it('tints warm near the horizon and neutral at height', () => {
    expect(sunState(6, undefined).sunColor.b).toBeLessThan(sunState(14, undefined).sunColor.b);
  });

  it('switches to the cool night light outside the arc', () => {
    expect(sunState(23, undefined).sunColor).toEqual({ r: 0.7, g: 0.8, b: 1 });
  });

  it('moves the sun continuously through the day, with no hourly step', () => {
    const before = sunState(13.999, undefined);
    const after = sunState(14.001, undefined);

    expect(after.direction.x).toBeCloseTo(before.direction.x, 2);
    expect(after.direction.y).toBeCloseTo(before.direction.y, 2);
    expect(after.sunIntensity).toBeCloseTo(before.sunIntensity, 6);
    expect(after.sunColor.g).toBeCloseTo(before.sunColor.g, 2);
  });
});

describe('the day/night switches', () => {
  /** One world-second either side of the switch. */
  const SECOND = 1 / 3600;

  /**
   * Direction and colour jump at 06:00 and 22:00: the moon stands high and cool, the sun low and
   * warm. The directional light is faded out across the switch so the jump happens while it
   * contributes nothing, and the ambient, which has no jump, carries the scene.
   */
  it.each([
    ['dawn', 6],
    ['dusk', 22],
  ])('has the directional light off on both sides of %s, where its direction and colour jump', (_name, hour) => {
    const before = sunState(hour - SECOND, undefined);
    const after = sunState(hour + SECOND, undefined);

    // The jump is real, which is what makes the fade necessary.
    expect(Math.abs(after.direction.y - before.direction.y)).toBeGreaterThan(0.5);
    expect(after.sunColor).not.toEqual(before.sunColor);
    // A thousandth of full, where an unfaded night light alone would be a quarter of it.
    expect(before.sunIntensity).toBeLessThan(FULL_SUN / 1000);
    expect(after.sunIntensity).toBeLessThan(FULL_SUN / 1000);
    expect(sunState(hour, undefined).sunIntensity).toBe(0);
    expect(after.ambientIntensity).toBeCloseTo(before.ambientIntensity, 0);
  });

  it.each([
    [5.5, 1],
    [5.75, 0.5],
    [6.25, 0.5],
    [6.5, 1],
    [21.5, 1],
    [21.75, 0.5],
    [22.25, 0.5],
    [22.5, 1],
  ])('fades the directional light linearly over the half hour either side: %s is at %s', (hour, factor) => {
    const state = sunState(hour, undefined);

    // The unfaded light is the ambient level times the full sun, so the ratio isolates the fade.
    expect(state.sunIntensity).toBeCloseTo((state.ambientIntensity / FULL_AMBIENT) * FULL_SUN * factor, 6);
  });

  it('leaves the light alone outside the two half hours', () => {
    for (const hour of [0, 3, 5.4, 6.6, 12, 21.4, 22.6]) {
      const state = sunState(hour, undefined);
      expect(state.sunIntensity).toBeCloseTo((state.ambientIntensity / FULL_AMBIENT) * FULL_SUN, 6);
    }
  });
});

describe('speech bubble wrap', () => {
  // Fixed-width oracle so the algorithm is tested without font metrics.
  const tenPerChar = (line: string) => line.length * 10;

  it('keeps a short line intact', () => {
    expect(wrapSpeech('hallo', tenPerChar)).toEqual(['hallo']);
  });

  it('wraps greedily at the bubble width', () => {
    const lines = wrapSpeech('aaaaa bbbbb ccccc ddddd', tenPerChar);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(tenPerChar(line)).toBeLessThanOrEqual(BUBBLE_WIDTH);
    }
  });

  /** A single unbreakable word wider than the bubble is emitted whole, not split mid-word. */
  it('emits an oversized single token as its own line', () => {
    const huge = 'x'.repeat(40);
    expect(wrapSpeech(huge, tenPerChar)).toEqual([huge]);
  });

  it('caps at four lines and marks truncation with an ASCII ellipsis', () => {
    const lines = wrapSpeech('aaaaaaaaaaaaaaa '.repeat(12).trim(), tenPerChar);
    expect(lines).toHaveLength(4);
    expect(lines[3]!.endsWith('...')).toBe(true);
    expect(lines.join('')).not.toContain('…');
  });

  it('does not mark truncation when everything fits', () => {
    expect(capLines(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('returns nothing for a zero line budget', () => {
    expect(capLines(['a'], 0)).toEqual([]);
  });

  it('derives the lifetime as two seconds plus one per line', () => {
    expect(bubbleLifetimeMs(1)).toBe(3000);
    expect(bubbleLifetimeMs(4)).toBe(6000);
  });
});
