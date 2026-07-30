import { describe, expect, it } from 'vitest'
import { clampToInt16, rectCenter } from '@/core/geometry'
import { contains, intersects, overlaps } from '@/core/collisionMaskOverlap'
import { clampToSector, feetCenter, feetHeight, feetRect, isFeetClear } from '@/core/feetMask'
import { SOMNIO_CONSTANTS } from '@/core/constants'
import { npcRuntimePosition } from '@/core/npcPlacement'
import { relativeDirection, speedMultiplier, tempoFromRaw, tempoPixelsPerSecond } from '@/core/tempo'
import { gridRounded } from '@/core/worldEntity'
import type { Sector } from '@/core/sector'

function makeSector(overrides: Partial<Sector> = {}): Sector {
  return {
    name: 'Test',
    version: 1,
    dimensions: { width: 4, height: 4 },
    floorMaterialID: 'grass-meadow',
    light: { indoor: false, brightness: 100 },
    objects: [],
    collisionMasks: [],
    portals: [],
    npcs: [],
    monsterSpawns: [],
    floorPatches: [],
    ...overrides,
  }
}

describe('feet-box arithmetic', () => {
  const player = SOMNIO_CONSTANTS.playerSpriteSize

  it('derives the feet height as spriteHeight / 4 + 4', () => {
    expect(feetHeight(player)).toBe(16)
    expect(feetHeight({ width: 32, height: 32 })).toBe(12)
    // Integer division truncates: 50 / 4 is 12, not 12.5.
    expect(feetHeight({ width: 32, height: 50 })).toBe(16)
  })

  it('bottom-aligns the feet rect at full sprite width', () => {
    expect(feetRect({ x: 100, y: 200 }, player)).toEqual({ x: 100, y: 232, width: 32, height: 16 })
  })

  it('centres on the feet, not the sprite top-left', () => {
    expect(feetCenter({ x: 100, y: 200 }, player)).toEqual({ x: 116, y: 240 })
  })
})

describe('collision overlap is right/bottom exclusive', () => {
  /**
   * The single most load-bearing polarity in the port: an inclusive comparison makes every wall
   * one pixel thicker than the server believes, so the client draws a stop where the server
   * would have allowed the step.
   */
  it('does not count rects flush along a far edge as overlapping', () => {
    const left = { x: 0, y: 0, width: 10, height: 10 }
    const flushRight = { x: 10, y: 0, width: 10, height: 10 }
    expect(overlaps(left, flushRight)).toBe(false)
    expect(overlaps(left, { x: 9, y: 0, width: 10, height: 10 })).toBe(true)
  })

  it('does not count rects flush along the bottom edge as overlapping', () => {
    const top = { x: 0, y: 0, width: 10, height: 10 }
    expect(overlaps(top, { x: 0, y: 10, width: 10, height: 10 })).toBe(false)
    expect(overlaps(top, { x: 0, y: 9, width: 10, height: 10 })).toBe(true)
  })

  it('treats a point on the right/bottom mask edge as outside', () => {
    const masks = [{ x: 0, y: 0, width: 10, height: 10 }]
    expect(contains({ x: 0, y: 0 }, masks)).toBe(true)
    expect(contains({ x: 9, y: 9 }, masks)).toBe(true)
    expect(contains({ x: 10, y: 5 }, masks)).toBe(false)
    expect(contains({ x: 5, y: 10 }, masks)).toBe(false)
  })

  it('intersects a rect against a mask list', () => {
    const masks = [{ x: 50, y: 50, width: 10, height: 10 }]
    expect(intersects({ x: 40, y: 40, width: 11, height: 11 }, masks)).toBe(true)
    expect(intersects({ x: 40, y: 40, width: 10, height: 10 }, masks)).toBe(false)
  })
})

describe('isFeetClear gates bounds, masks, and blockers', () => {
  const player = SOMNIO_CONSTANTS.playerSpriteSize
  const sector = makeSector({ collisionMasks: [{ x: 200, y: 200, width: 64, height: 64 }] })

  it('accepts a clear position', () => {
    expect(isFeetClear({ x: 10, y: 10 }, player, sector, [])).toBe(true)
  })

  it('rejects a negative origin', () => {
    expect(isFeetClear({ x: -1, y: 10 }, player, sector, [])).toBe(false)
  })

  it('rejects a feet box past the sector edge', () => {
    // 4 tiles x 128 = 512 px. A 32-wide sprite at x=480 is exactly flush and allowed.
    expect(isFeetClear({ x: 480, y: 400 }, player, sector, [])).toBe(true)
    expect(isFeetClear({ x: 481, y: 400 }, player, sector, [])).toBe(false)
  })

  it('rejects a feet box overlapping a collision mask', () => {
    expect(isFeetClear({ x: 200, y: 200, ...{} }, player, sector, [])).toBe(false)
  })

  it('rejects a feet box overlapping a blocker', () => {
    const blocker = feetRect({ x: 100, y: 100 }, player)
    expect(isFeetClear({ x: 100, y: 100 }, player, sector, [blocker])).toBe(false)
    expect(isFeetClear({ x: 300, y: 300 }, player, sector, [blocker])).toBe(true)
  })
})

describe('clampToSector lands the feet box flush against an edge', () => {
  const player = SOMNIO_CONSTANTS.playerSpriteSize
  const sector = makeSector()

  it('clamps past the right edge to flush', () => {
    expect(clampToSector({ x: 9999, y: 100 }, player, sector).x).toBe(512 - 32)
  })

  it('clamps past the bottom edge to flush', () => {
    expect(clampToSector({ x: 100, y: 9999 }, player, sector).y).toBe(512 - 48)
  })

  /**
   * The lower Y bound is `feetHeight - spriteHeight`, i.e. negative: the sprite's head may hang
   * above the sector as long as the feet box stays inside.
   */
  it('allows the sprite head above the sector while the feet stay inside', () => {
    expect(clampToSector({ x: 100, y: -9999 }, player, sector).y).toBe(16 - 48)
  })

  it('does not invert the range for a sector smaller than the sprite', () => {
    const tiny = makeSector({ dimensions: { width: 1, height: 1 } })
    const clamped = clampToSector({ x: 9999, y: 9999 }, { width: 200, height: 300 }, tiny)
    expect(Number.isFinite(clamped.x)).toBe(true)
    expect(Number.isFinite(clamped.y)).toBe(true)
  })
})

describe('tempo and relative direction', () => {
  it('maps tempo to pixels per second', () => {
    expect(tempoPixelsPerSecond(1)).toBe(50)
    expect(tempoPixelsPerSecond(2)).toBe(100)
    expect(tempoPixelsPerSecond(4)).toBe(150)
  })

  it('falls back to default for an unknown wire tempo', () => {
    expect(tempoFromRaw(3)).toBe(2)
    expect(tempoFromRaw(0)).toBe(2)
    expect(tempoFromRaw(4)).toBe(4)
  })

  it.each([
    [0, 0, 'forward'],
    [45, 0, 'forward'],
    [46, 0, 'strafeLeft'],
    [135, 0, 'strafeLeft'],
    [136, 0, 'backward'],
    [180, 0, 'backward'],
    [270, 0, 'strafeRight'],
    // A -45 degree arc is still within the forward bucket, so this is not a strafe.
    [315, 0, 'forward'],
  ])('travel %s against facing %s is %s', (travel, facing, expected) => {
    expect(relativeDirection(travel, facing)).toBe(expected)
  })

  it('owns 45 by forward and 135 by strafe', () => {
    expect(relativeDirection(45, 0)).toBe('forward')
    expect(relativeDirection(135, 0)).toBe('strafeLeft')
  })

  it('applies the speed penalty per direction', () => {
    expect(speedMultiplier('forward')).toBe(1.0)
    expect(speedMultiplier('backward')).toBe(0.5)
    expect(speedMultiplier('strafeLeft')).toBe(0.7)
    expect(speedMultiplier('strafeRight')).toBe(0.7)
  })
})

describe('NPC placement centres inside the spawn box', () => {
  it('offsets by half the difference between box and mask', () => {
    expect(
      npcRuntimePosition({
        spawnOrigin: { x: 100, y: 200 },
        spawnBoxSize: { width: 128, height: 128 },
        maskSize: { width: 32, height: 48 },
        name: 'Libus',
        figure: 16,
        facing: 0,
        behaviorTag: 0,
        dialogScript: '',
      })
    ).toEqual({ x: 148, y: 240 })
  })
})

describe('grid rounding', () => {
  it('rounds half away from zero, matching Swift', () => {
    expect(gridRounded({ x: 2.5, y: -2.5 })).toEqual({ x: 3, y: -3 })
    expect(gridRounded({ x: 1.4, y: -1.4 })).toEqual({ x: 1, y: -1 })
  })

  it('clamps into the Int16 pixel domain', () => {
    expect(gridRounded({ x: 99_999, y: -99_999 })).toEqual({ x: 32_767, y: -32_768 })
  })
})

describe('integer helpers', () => {
  it('truncates rect centres toward zero', () => {
    expect(rectCenter({ x: 0, y: 0, width: 5, height: 5 })).toEqual({ x: 2, y: 2 })
    expect(rectCenter({ x: 10, y: 10, width: 4, height: 4 })).toEqual({ x: 12, y: 12 })
  })

  it('clamps to the Int16 range', () => {
    expect(clampToInt16(40_000)).toBe(32_767)
    expect(clampToInt16(-40_000)).toBe(-32_768)
    expect(clampToInt16(123)).toBe(123)
  })
})
