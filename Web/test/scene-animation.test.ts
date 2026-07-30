import { describe, expect, it } from 'vitest'
import { f32 } from '@/core/float'
import { CLIP_PREFERENCES, movementPose, resolveClipName } from '@/scene/animation'
import { outdoorAmbient, smoothedOutdoorAmbient, sunState } from '@/scene/dayNightSun'
import { BUBBLE_WIDTH, bubbleLifetimeMs, capLines, wrapSpeech } from '@/scene/speechBubbleText'

describe('movementPose', () => {
  it.each([
    [1, 'forward', 'sneaking'],
    [2, 'forward', 'walking'],
    [4, 'forward', 'running'],
  ] as const)('player at tempo %s moving %s uses %s', (tempo, direction, pose) => {
    expect(movementPose('player', tempo, direction)).toBe(pose)
  })

  /** No tier-specific backpedal or strafe clips exist, so those collapse regardless of tempo. */
  it.each([1, 2, 4] as const)('backpedal collapses to one clip at tempo %s', (tempo) => {
    expect(movementPose('player', tempo, 'backward')).toBe('backpedal')
  })

  it.each([1, 2, 4] as const)('strafing collapses to one clip per side at tempo %s', (tempo) => {
    expect(movementPose('player', tempo, 'strafeLeft')).toBe('strafeLeft')
    expect(movementPose('player', tempo, 'strafeRight')).toBe('strafeRight')
  })

  it('shares the player pose set with peers', () => {
    expect(movementPose('peer', 4, 'forward')).toBe('running')
  })

  /** The librarian must not skulk through its own room, so NPCs ignore tempo and direction. */
  it.each([
    ['npc', 1, 'backward'],
    ['npc', 4, 'forward'],
    ['monster', 4, 'strafeLeft'],
  ] as const)('%s at tempo %s moving %s always walks', (kind, tempo, direction) => {
    expect(movementPose(kind, tempo, direction)).toBe('walking')
  })
})

describe('clip preference chains', () => {
  it('prefers the exact clip when present', () => {
    expect(resolveClipName('running', ['Idle', 'Walking_A', 'Running_A'])).toBe('Running_A')
  })

  it('falls back to the walk clip for a model converted before the tier existed', () => {
    expect(resolveClipName('sneaking', ['Idle', 'Walking_A'])).toBe('Walking_A')
    expect(resolveClipName('strafeLeft', ['Idle', 'Walking_A'])).toBe('Walking_A')
  })

  /**
   * The Ghost carries only `Flying_Idle`, so every pose has to reach it — otherwise its drift
   * freezes on any pose whose chain runs out.
   */
  it.each(Object.keys(CLIP_PREFERENCES) as (keyof typeof CLIP_PREFERENCES)[])(
    'pose %s reaches Flying_Idle for a ghost-like model',
    (pose) => {
      expect(resolveClipName(pose, ['Flying_Idle'])).toBe('Flying_Idle')
    }
  )

  it('resolves nothing when the model has no usable clip', () => {
    expect(resolveClipName('idle', ['Unrelated'])).toBeUndefined()
  })
})

describe('day/night ambient staircase', () => {
  /**
   * `minute / 12` is integer division in Swift, so the hour steps through five discrete buckets
   * rather than ramping. A float divide would smooth the step and drift from the native tint.
   */
  it('steps the minute contribution in five discrete buckets', () => {
    const values = [0, 11, 12, 23, 24, 35, 36, 47, 48, 59].map((minute) => outdoorAmbient(7, minute, 100))
    expect(values).toEqual([25, 25, 30, 30, 35, 35, 40, 40, 45, 45])
  })

  it('holds full brightness through the middle of the day', () => {
    expect(outdoorAmbient(12, 30, 100)).toBe(100)
    expect(outdoorAmbient(17, 59, 100)).toBe(100)
  })

  it('floors the night hours', () => {
    expect(outdoorAmbient(23, 0, 100)).toBe(1)
    expect(outdoorAmbient(3, 0, 100)).toBe(1)
    expect(outdoorAmbient(22, 0, 100)).toBe(1)
  })

  /** Night floors dim rather than black: the raw staircase is pulled a quarter toward full. */
  it('smooths the night floor to 25.75 rather than 1', () => {
    expect(smoothedOutdoorAmbient(23, 0, 100)).toBe(25.75)
    expect(smoothedOutdoorAmbient(12, 0, 100)).toBe(100)
  })
})

describe('sun state', () => {
  it('uses the fixed indoor key with no arc', () => {
    const indoor = sunState(12, 0, { indoor: true, brightness: 100 })
    const midnightIndoor = sunState(0, 0, { indoor: true, brightness: 100 })
    expect(indoor.direction).toEqual(midnightIndoor.direction)
    expect(indoor.sunColor).toEqual({ r: 1, g: 1, b: 1 })
  })

  it('scales indoor intensity by the authored brightness', () => {
    const bright = sunState(12, 0, { indoor: true, brightness: 100 })
    const dim = sunState(12, 0, { indoor: true, brightness: 50 })
    expect(dim.sunIntensity).toBeCloseTo(bright.sunIntensity / 2, 6)
  })

  it('holds the sun on or above the horizon through the whole day arc', () => {
    // Elevation is `sin(progress * pi)`, so it is exactly 0 at sunrise — the sun sits *on* the
    // horizon at 06:00 and climbs from there.
    expect(sunState(6, 0, { indoor: false, brightness: 100 }).direction.y).toBe(0)
    for (let hour = 7; hour < 22; hour += 1) {
      expect(sunState(hour, 0, { indoor: false, brightness: 100 }).direction.y).toBeGreaterThan(0)
    }
  })

  /** Peak elevation stays below 90 degrees so shadows always have a direction to fall in. */
  it('never puts the sun directly overhead', () => {
    for (let hour = 6; hour < 22; hour += 1) {
      expect(sunState(hour, 0, { indoor: false, brightness: 100 }).direction.y).toBeLessThan(0.95)
    }
  })

  it('rises in the east and sets in the west', () => {
    const morning = sunState(7, 0, { indoor: false, brightness: 100 })
    const evening = sunState(20, 0, { indoor: false, brightness: 100 })
    expect(morning.direction.x).toBeGreaterThan(0)
    expect(evening.direction.x).toBeLessThan(0)
  })

  it('leans the arc south so midday shadows stay visible', () => {
    // Without the lean, a midday sun sits directly overhead and shadows vanish under casters.
    expect(sunState(14, 0, { indoor: false, brightness: 100 }).direction.z).toBeGreaterThan(0)
  })

  it('tints warm near the horizon and neutral at height', () => {
    const dawn = sunState(6, 0, { indoor: false, brightness: 100 })
    const noon = sunState(14, 0, { indoor: false, brightness: 100 })
    expect(dawn.sunColor.b).toBeLessThan(noon.sunColor.b)
  })

  it('switches to the cool night light outside the arc', () => {
    const night = sunState(23, 0, { indoor: false, brightness: 100 })
    // `nightColor` is a `SIMD3<Float>` in `DayNightSun.swift`, and neither 0.7 nor 0.8 is
    // representable in binary32 — so the narrowed constants are the native values and the plain
    // decimals are not. Written through `f32` rather than as `0.699999988079071` literals so the
    // assertion states which contract it is pinning.
    expect(night.sunColor).toEqual({ r: f32(0.7), g: f32(0.8), b: 1 })
    expect(night.sunColor.r).not.toBe(0.7)
  })
})

describe('speech bubble wrap', () => {
  // Fixed-width oracle so the algorithm is tested without font metrics.
  const tenPerChar = (line: string) => line.length * 10

  it('keeps a short line intact', () => {
    expect(wrapSpeech('hallo', tenPerChar)).toEqual(['hallo'])
  })

  it('wraps greedily at the bubble width', () => {
    const lines = wrapSpeech('aaaaa bbbbb ccccc ddddd', tenPerChar)
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      expect(tenPerChar(line)).toBeLessThanOrEqual(BUBBLE_WIDTH)
    }
  })

  /** A single unbreakable word wider than the bubble is emitted whole, not split mid-word. */
  it('emits an oversized single token as its own line', () => {
    const huge = 'x'.repeat(40)
    expect(wrapSpeech(huge, tenPerChar)).toEqual([huge])
  })

  it('caps at four lines and marks truncation with an ASCII ellipsis', () => {
    const lines = wrapSpeech('aaaaaaaaaaaaaaa '.repeat(12).trim(), tenPerChar)
    expect(lines).toHaveLength(4)
    expect(lines[3]!.endsWith('...')).toBe(true)
    expect(lines.join('')).not.toContain('…')
  })

  it('does not mark truncation when everything fits', () => {
    expect(capLines(['a', 'b'])).toEqual(['a', 'b'])
  })

  it('returns nothing for a zero line budget', () => {
    expect(capLines(['a'], 0)).toEqual([])
  })

  it('derives the lifetime as two seconds plus one per line', () => {
    expect(bubbleLifetimeMs(1)).toBe(3000)
    expect(bubbleLifetimeMs(4)).toBe(6000)
  })
})
