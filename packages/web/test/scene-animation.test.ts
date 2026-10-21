import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { GAITS } from '@somnio/protocol';
import { CLIP_PREFERENCES, ONE_SHOT_CLIPS, movementPose, resolveClipName, resolveOneShotClipName } from '@/scene/animation';
import { worldMovement } from '@/scene/cameraRig';
import { sunState } from '@/scene/dayNightSun';
import { BUBBLE_TEXT_WIDTH, bubbleLifetimeMs, wrapSpeech } from '@/scene/speechBubbleText';

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
  /** What the player's model and the Ghost carry, as the registry expects of each. */
  const DREAMER = ['Idle', 'Walking_A', 'Death_A', 'Hit_A', 'Interact'];
  const GHOST = ['Flying_Idle', 'Death', 'HitReact', 'Punch'];

  it.each([
    ['fallen', 'Death_A', 'Death'],
    ['swing', 'Interact', 'Punch'],
    ['flinch', 'Hit_A', 'HitReact'],
  ] as const)('resolves %s to %s on a dreamer and %s on a Ghost', (oneShot, dreamer, ghost) => {
    expect(resolveOneShotClipName(oneShot, DREAMER)).toBe(dreamer);
    expect(resolveOneShotClipName(oneShot, GHOST)).toBe(ghost);
  });

  /** An event has no fallback: a model without the clip keeps the pose it is looping. */
  it.each(Object.keys(ONE_SHOT_CLIPS) as (keyof typeof ONE_SHOT_CLIPS)[])('resolves nothing for %s on a model that carries only looping clips', (oneShot) => {
    expect(resolveOneShotClipName(oneShot, ['Idle', 'Walking_A', 'Flying_Idle'])).toBeUndefined();
  });
});

/** The plan of the outdoor light: each value's anchors by hour, read with linear interpolation between them. */
const SUN_ANCHORS = [
  [0, 0.9],
  [5, 0.9],
  [7, 1.8],
  [10, 3],
  [18, 3],
  [19, 1.8],
  [22, 0.9],
  [24, 0.9],
] as const;
const HEMISPHERE_ANCHORS = [
  [0, 0.8],
  [5, 0.8],
  [7, 0.7],
  [10, 0.9],
  [18, 0.9],
  [19, 0.7],
  [22, 0.8],
  [24, 0.8],
] as const;

function anchored(anchors: readonly (readonly [number, number])[], hour: number): number {
  const next = anchors.findIndex(([at]) => at > hour);
  const [fromHour, from] = anchors[next - 1]!;
  const [toHour, to] = anchors[next]!;
  return from + ((to - from) * (hour - fromHour)) / (toHour - fromHour);
}

/** An sRGB hex colour as three.js reads it into its linear working space. */
function linear(hex: number): { r: number; g: number; b: number } {
  const { r, g, b } = new THREE.Color(hex);
  return { r, g, b };
}

function expectColor(actual: { r: number; g: number; b: number }, expected: { r: number; g: number; b: number }): void {
  expect(actual.r).toBeCloseTo(expected.r, 6);
  expect(actual.g).toBeCloseTo(expected.g, 6);
  expect(actual.b).toBeCloseTo(expected.b, 6);
}

describe('outdoor light', () => {
  it.each([
    ['noon', [10, 12.5, 17.99, 18], 0xfff4e0, 0xdce9ff, 0x74654b, 0x7a8a79],
    ['night', [0, 3, 5, 22.5, 23.99], 0xa9bcff, 0x5a70b0, 0x2c2c3c, 0x1b2233],
    ['dawn', [7], 0xffa860, 0xffc9a0, 0x5a4636, 0x6b5a58],
    ['dusk', [19], 0xffa860, 0xffc9a0, 0x5a4636, 0x6b5a58],
  ])('holds the %s colours at their anchor hours', (_name, hours, sunColor, sky, ground, backdrop) => {
    for (const hour of hours) {
      const state = sunState(hour, undefined);
      expectColor(state.sunColor, linear(sunColor));
      expectColor(state.skyColor, linear(sky));
      expectColor(state.groundColor, linear(ground));
      expectColor(state.backdropColor, linear(backdrop));
    }
  });

  /** A ramp, not a staircase: any minute sits on the straight line between its hour's two anchors. */
  it('reads every intensity from the one table, interpolating linearly between anchors', () => {
    for (let hour = 0; hour < 24; hour += 0.1) {
      const state = sunState(hour, undefined);
      expect(state.hemisphereIntensity).toBeCloseTo(anchored(HEMISPHERE_ANCHORS, hour), 9);
      if (Math.min(Math.abs(hour - 6), Math.abs(hour - 22)) >= 0.5) expect(state.sunIntensity).toBeCloseTo(anchored(SUN_ANCHORS, hour), 9);
    }
  });

  it('mixes the colours in linear space between anchors', () => {
    const noon = linear(0xdce9ff);
    const dusk = linear(0xffc9a0);
    expectColor(sunState(18.5, undefined).skyColor, { r: (noon.r + dusk.r) / 2, g: (noon.g + dusk.g) / 2, b: (noon.b + dusk.b) / 2 });
  });
});

describe('sun state', () => {
  it('uses the fixed interior key with no arc', () => {
    const interior = sunState(12, 100);
    const midnightInterior = sunState(0, 100);
    expect(interior).toEqual(midnightInterior);
    expectColor(interior.sunColor, linear(0xffe6c4));
    expectColor(interior.skyColor, linear(0xf3dfc6));
    expectColor(interior.groundColor, linear(0x645143));
    expectColor(interior.backdropColor, linear(0x24282c));
  });

  it('scales interior intensity by the authored brightness', () => {
    const bright = sunState(12, 100);
    const dim = sunState(12, 50);
    expect(bright.sunIntensity).toBeCloseTo(3, 9);
    expect(bright.hemisphereIntensity).toBeCloseTo(1.1, 9);
    expect(dim.sunIntensity).toBeCloseTo(bright.sunIntensity / 2, 9);
    expect(dim.hemisphereIntensity).toBeCloseTo(bright.hemisphereIntensity / 2, 9);
    expect(dim.backdropColor).toEqual(bright.backdropColor);
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

  /** The sun goes round the world: its bearing turns at an even pace, so the shadows it throws wheel round their casters all day. */
  it('turns the sun round the world at an even pace through the day', () => {
    const bearing = (hour: number): number => {
      const { direction } = sunState(hour, undefined);
      return (Math.atan2(direction.z, direction.x) * 180) / Math.PI;
    };
    const turned = (from: number, to: number): number => (((bearing(to) - bearing(from)) % 360) + 360) % 360;
    for (let hour = 7; hour < 21; hour += 1) expect(turned(hour, hour + 1)).toBeCloseTo(15, 9);
    // The daylight part of the splash reel's time-lapse shot, from four to the day's end.
    expect(turned(16, 21.75)).toBeGreaterThan(80);
  });

  /** Where the camera stands, the ground behind a caster is hidden for as far as the caster is tall. */
  it('keeps the high sun off the camera side, where its short shadows would fall out of sight', () => {
    const toCamera = worldMovement(0, 1);
    for (let hour = 6.25; hour < 22; hour += 0.25) {
      const { direction } = sunState(hour, undefined);
      if (direction.y < Math.sin((30 * Math.PI) / 180)) continue;
      const along = (direction.x * toCamera.dx + direction.z * toCamera.dz) / Math.hypot(direction.x, direction.z);
      expect(along).toBeLessThan(Math.cos((40 * Math.PI) / 180));
    }
  });

  /** At its highest the sun stands to the camera's left, so round midday shadows fall across the screen. */
  it('throws the shadows round midday to one side of their casters as the camera sees them', () => {
    const right = worldMovement(1, 0);
    for (let hour = 13; hour <= 15; hour += 0.25) {
      const { direction } = sunState(hour, undefined);
      expect(Math.abs(direction.x * right.dx + direction.z * right.dz) / direction.y).toBeGreaterThan(0.4);
    }
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
   * Direction jumps at 06:00 and 22:00: the moon stands high, the sun low. The directional light is
   * faded out across the switch so the jump happens while it contributes nothing, and the
   * hemisphere fill, which has no jump, carries the scene.
   */
  it.each([
    ['dawn', 6],
    ['dusk', 22],
  ])('has the directional light off on both sides of %s, where its direction jumps', (_name, hour) => {
    const before = sunState(hour - SECOND, undefined);
    const after = sunState(hour + SECOND, undefined);

    // The jump is real, which is what makes the fade necessary.
    expect(Math.abs(after.direction.y - before.direction.y)).toBeGreaterThan(0.5);
    expect(before.sunIntensity).toBeLessThan(0.01);
    expect(after.sunIntensity).toBeLessThan(0.01);
    expect(sunState(hour, undefined).sunIntensity).toBe(0);
    expect(after.hemisphereIntensity).toBeCloseTo(before.hemisphereIntensity, 3);
    expect(after.backdropColor.b).toBeCloseTo(before.backdropColor.b, 3);
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
    expect(sunState(hour, undefined).sunIntensity).toBeCloseTo(anchored(SUN_ANCHORS, hour) * factor, 6);
  });
});

describe('speech bubble wrap', () => {
  // Fixed-width oracle so the algorithm is tested without font metrics.
  const tenPerChar = (line: string) => line.length * 10;

  it('keeps a short line intact', () => {
    expect(wrapSpeech('hallo', tenPerChar)).toEqual(['hallo']);
  });

  /** 5px short of each side of the 150px bubble, so no letter touches its outline. */
  it('wraps greedily inside the bubble', () => {
    expect(BUBBLE_TEXT_WIDTH).toBe(140);
    const lines = wrapSpeech('aaaaa bbbbb ccccc ddddd', tenPerChar);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(tenPerChar(line)).toBeLessThanOrEqual(BUBBLE_TEXT_WIDTH);
    }
  });

  /** Squeezed onto one line by the renderer instead, it would be unreadable. */
  it('breaks a word wider than a line across lines', () => {
    expect(wrapSpeech(`hi ${'x'.repeat(20)} ok`, tenPerChar)).toEqual(['hi', 'x'.repeat(14), `${'x'.repeat(6)} ok`]);
  });

  it('breaks a long word between graphemes, never inside one', () => {
    const lines = wrapSpeech(
      'ü'.repeat(10) + '👍🏽'.repeat(10),
      (line) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line)].length * 10,
    );
    expect(lines.join('')).toBe('ü'.repeat(10) + '👍🏽'.repeat(10));
    expect(lines.map((line) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line)].length)).toEqual([14, 6]);
    // Measured by code unit, a thumb fits where its skin tone does not; split there, the tone would start the next line on its own.
    expect(wrapSpeech('👍🏽'.repeat(10), tenPerChar)).toEqual(['👍🏽'.repeat(3), '👍🏽'.repeat(3), '👍🏽'.repeat(3), '👍🏽']);
  });

  it('caps at four lines and marks truncation with an ASCII ellipsis', () => {
    const lines = wrapSpeech('aaaaaaaaaaaaaaa '.repeat(12).trim(), tenPerChar);
    expect(lines).toHaveLength(4);
    expect(lines[3]!.endsWith('...')).toBe(true);
    expect(lines.join('')).not.toContain('…');
  });

  const threeFullLines = `${'a'.repeat(14)} ${'b'.repeat(14)} ${'c'.repeat(14)}`;

  it('cuts a full last line back so the truncation mark fits beside it', () => {
    expect(wrapSpeech(`${threeFullLines} dddd eeeeeeeee f`, tenPerChar).at(-1)).toBe('dddd eeeeee...');
  });

  it('leaves no space before the truncation mark where the cut ends a word', () => {
    expect(wrapSpeech(`${threeFullLines} dddddddddd eee f`, tenPerChar).at(-1)).toBe('dddddddddd...');
  });

  it('derives the lifetime as two seconds plus one per line', () => {
    expect(bubbleLifetimeMs(1)).toBe(3000);
    expect(bubbleLifetimeMs(4)).toBe(6000);
  });
});
