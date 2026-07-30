import { describe, expect, it } from 'vitest'
import {
  MIN_SCALE,
  ORTHO_RIG,
  applyScrollZoom,
  cameraPosition,
  clampedScale,
  frustumBounds,
  legacyPoint,
  offsetDirection,
  scaleForZoomFactor,
  worldMovement,
  worldPosition,
} from '@/scene/cameraRig'
import { yawStep } from '@/scene/yawSlew'
import {
  characterScale,
  entityWorldPosition,
  floorPatchUVRect,
  objectAnchorBottomY,
  objectNodePosition,
} from '@/scene/placement'
import { SOMNIO_CONSTANTS } from '@/core/constants'
import type { SectorObject } from '@/core/sector'

/** Expectations produced by compiling and running the Swift rig, not re-derived here. */

describe('orthographic scale is a HALF-height', () => {
  /**
   * The single most consequential mapping in the renderer. `scale` is the vertical half-height —
   * the render spans `2 x scale` metres — so `top/bottom = +/-scale`. Three.js examples almost
   * always show `frustumSize / 2`, and applying that idiom here halves an already-halved value
   * and renders the whole world at 2x magnification.
   */
  it('maps scale directly to top and bottom, not scale/2', () => {
    const bounds = frustumBounds(3, 1)
    expect(bounds.top).toBe(3)
    expect(bounds.bottom).toBe(-3)
    expect(bounds.top).not.toBe(1.5)
  })

  it('spans 2 x scale metres vertically', () => {
    const bounds = frustumBounds(3, 1.5)
    expect(bounds.top - bounds.bottom).toBe(6)
  })

  it('lets aspect drive width while the vertical extent stays fixed', () => {
    const wide = frustumBounds(3, 2)
    const tall = frustumBounds(3, 0.5)
    // MMO fairness: every window size shows the same vertical world extent, so a bigger window
    // magnifies rather than reveals.
    expect(wide.top - wide.bottom).toBe(tall.top - tall.bottom)
    expect(wide.right - wide.left).toBe(12)
    expect(tall.right - tall.left).toBe(3)
  })
})

describe('rig constants and derived bounds', () => {
  it('derives minScale from the zoom clamp so the two agree by construction', () => {
    expect(MIN_SCALE).toBe(1.5)
  })

  it('clamps scale into the interactive range', () => {
    expect(clampedScale(0.1)).toBe(MIN_SCALE)
    expect(clampedScale(100)).toBe(ORTHO_RIG.maxScale)
    expect(clampedScale(3)).toBe(3)
  })

  it('inverts the zoom factor into a camera scale', () => {
    expect(scaleForZoomFactor(1)).toBe(3)
    expect(scaleForZoomFactor(2)).toBe(1.5)
    expect(scaleForZoomFactor(0.5)).toBe(6)
  })
})

describe('offsetDirection matches the Swift Float chain', () => {
  it('is the pitch/yaw unit vector', () => {
    const direction = offsetDirection()
    expect(direction.x).toBe(0.4055797755718231)
    expect(direction.y).toBe(0.7071067690849304)
    expect(direction.z).toBe(0.5792279839515686)
  })

  it('places the camera back along that direction', () => {
    const position = cameraPosition({ x: 0, y: 0, z: 0 })
    expect(position.x).toBeCloseTo(0.4055797755718231 * ORTHO_RIG.cameraDistance, 4)
    expect(position.y).toBeCloseTo(0.7071067690849304 * ORTHO_RIG.cameraDistance, 4)
  })
})

describe('worldMovement rotates WASD through the camera yaw', () => {
  /**
   * Double precision on purpose: `dx`/`dy` are `Double` in the Swift original, so this is one of
   * the few rig functions with no narrowing.
   */
  it.each([
    [1, 0, 0.8191520442889918, -0.573576436351046],
    [0, -1, -0.573576436351046, -0.8191520442889918],
    [0, 1, 0.573576436351046, 0.8191520442889918],
    [-1, 0, -0.8191520442889918, 0.573576436351046],
    [0.6, 0.8, 0.9503523756542319, 0.31117577362056587],
  ])('screen (%s, %s) becomes world (%s, %s)', (dx, dy, wx, wy) => {
    const moved = worldMovement(dx, dy)
    expect(moved.dx).toBe(wx)
    expect(moved.dy).toBe(wy)
  })

  it('is a pure rotation, so a unit input stays unit length', () => {
    const moved = worldMovement(0.7071067811865476, -0.7071067811865476)
    expect(Math.hypot(moved.dx, moved.dy)).toBeCloseTo(1, 12)
  })

  it('walks up-screen away from the viewer rather than along world north', () => {
    const up = worldMovement(0, -1)
    expect(up.dx).toBeLessThan(0)
    expect(up.dy).toBeLessThan(0)
  })
})

describe('pixel/world mapping', () => {
  it('maps legacy pixels onto the floor plane', () => {
    expect(worldPosition(100, 200)).toEqual({ x: 2, y: 0, z: 4 })
  })

  it('round-trips through the inverse', () => {
    const point = legacyPoint(worldPosition(384, 256))
    expect(point).toEqual({ x: 384, y: 256 })
  })
})

describe('yawStep takes the shortest arc', () => {
  it.each([
    [0, 1.5707963705062866, 0.0166667, 0.14959993958473206],
    [3.0, -3.0, 0.0166667, -3.133584976196289],
    [0, 0.0010000000474974513, 0.0166667, 0.0010000000474974513],
    [1.0, 1.0, 0.0166667, 1.0],
  ])('from %s toward %s over %s s is %s', (current, target, dt, expected) => {
    expect(yawStep(current, target, dt)).toBe(expected)
  })

  /**
   * The exact-180-degree case. The IEEE remainder rounds the quotient to nearest rather than
   * truncating, so this resolves to one consistent turn direction; with `%` the entity
   * oscillates instead of turning.
   */
  it('resolves an exact half-turn to one consistent direction', () => {
    expect(yawStep(0, 3.1415927410125732, 0.0166667)).toBe(-0.14959993958473206)
  })

  it('snaps to the target rather than overshooting when the step covers the delta', () => {
    expect(yawStep(0, 0.001, 1)).toBe(f32Of(0.001))
  })

  it('completes a quarter turn in 0.175 s', () => {
    const quarter = 1.5707963705062866
    expect(Math.abs(yawStep(0, quarter, 0.175))).toBeCloseTo(quarter, 4)
  })
})

function f32Of(value: number): number {
  return Math.fround(value)
}

describe('characterScale is derived from the mask, never measured', () => {
  it.each([
    [48, 0.7399999499320984],
    [32, 0.4933333098888397],
    [64, 0.9866666197776794],
    [96, 1.4799998998641968],
  ])('mask height %s scales to %s', (height, expected) => {
    expect(characterScale({ width: 32, height })).toBe(expected)
  })

  it('scales the standard player sprite to roughly three quarters of a metre', () => {
    expect(characterScale(SOMNIO_CONSTANTS.playerSpriteSize)).toBeCloseTo(0.74, 5)
  })
})

describe('objectAnchorBottomY', () => {
  const object: SectorObject = {
    x: 100,
    y: 100,
    modelID: 'barrel',
    sourceWidth: 64,
    sourceHeight: 64,
    priority: 0,
    rotation: 0,
  }

  it('defaults to the decal rect bottom with no overlapping mask', () => {
    expect(objectAnchorBottomY(object, [])).toBe(164)
  })

  /**
   * The mask is the authored physical footprint; art below it is deliberate 2D front-face
   * overhang. Painter's order made that read fine in 2D, but in 3D the player walks inside the
   * mesh unless the mask's south edge wins.
   */
  it('lets an overlapping mask ending within one ground cell above the edge win', () => {
    const mask = { x: 100, y: 100, width: 64, height: 44 } // bottom 144, within 32 of 164
    expect(objectAnchorBottomY(object, [mask])).toBe(144)
  })

  it('ignores a mask further than one ground cell above the edge', () => {
    const mask = { x: 100, y: 100, width: 64, height: 20 } // bottom 120, more than 32 above 164
    expect(objectAnchorBottomY(object, [mask])).toBe(164)
  })

  /** A table's mask under a chair standing behind it must not drag the chair south. */
  it('never lets a mask ending below the rect pull the prop south', () => {
    const mask = { x: 100, y: 100, width: 64, height: 200 } // bottom 300, below 164
    expect(objectAnchorBottomY(object, [mask])).toBe(164)
  })

  it('ignores a mask that does not overlap the decal horizontally', () => {
    const mask = { x: 400, y: 100, width: 64, height: 44 }
    expect(objectAnchorBottomY(object, [mask])).toBe(164)
  })

  it('takes the southernmost qualifying mask', () => {
    const masks = [
      { x: 100, y: 100, width: 64, height: 40 },
      { x: 100, y: 100, width: 64, height: 50 },
    ]
    expect(objectAnchorBottomY(object, masks)).toBe(150)
  })
})

describe('objectNodePosition anchors the footprint south edge', () => {
  it('centres X on the footprint and pushes back by half the depth', () => {
    const object: SectorObject = {
      x: 100,
      y: 100,
      modelID: 'barrel',
      sourceWidth: 64,
      sourceHeight: 64,
      priority: 0,
      rotation: 0,
    }
    const position = objectNodePosition(object, 164, 1)
    expect(position.x).toBeCloseTo(132 * 0.02, 6)
    // 164 px maps to 3.28 m, then back half the 1 m footprint depth.
    expect(position.z).toBeCloseTo(164 * 0.02 - 0.5, 6)
  })
})

describe('entityWorldPosition stands entities at their feet-box centre', () => {
  it('offsets by the feet centre rather than the sprite origin', () => {
    const position = entityWorldPosition({ x: 0, y: 0 }, SOMNIO_CONSTANTS.playerSpriteSize)
    // Feet centre of a 32x48 sprite at the origin is (16, 40).
    expect(position.x).toBeCloseTo(16 * 0.02, 6)
    expect(position.z).toBeCloseTo(40 * 0.02, 6)
  })

  it('carries the sub-pixel fraction through', () => {
    const whole = entityWorldPosition({ x: 10, y: 10 }, SOMNIO_CONSTANTS.playerSpriteSize)
    const fractional = entityWorldPosition({ x: 10.5, y: 10 }, SOMNIO_CONSTANTS.playerSpriteSize)
    expect(fractional.x).toBeGreaterThan(whole.x)
  })
})

describe('floor patch UVs are in sector space', () => {
  it.each([
    [0, 0, 128, 128, 1, 0, 0, 1.5999999046325684, 1.5999999046325684],
    [128, 0, 128, 128, 1, 1.5999999046325684, 0, 1.5999999046325684, 1.5999999046325684],
    [384, 256, 64, 64, 1, 4.799999713897705, 3.1999998092651367, 0.7999999523162842, 0.7999999523162842],
  ])('patch (%s, %s, %s, %s) at aspect %s', (x, y, width, height, aspect, originX, originY, spanX, spanY) => {
    const uv = floorPatchUVRect({ floorMaterialID: 'cobble-town', x, y, width, height }, aspect)
    expect(uv.origin.x).toBe(originX)
    expect(uv.origin.y).toBe(originY)
    expect(uv.span.x).toBe(spanX)
    expect(uv.span.y).toBe(spanY)
  })

  /**
   * The continuity contract, asserted directly: abutting same-material rects must share their
   * edge UVs exactly, or the texture phase resets at every seam and a cobbled street visibly
   * tile-breaks at each rect boundary.
   */
  it('makes one patch end exactly where its neighbour begins', () => {
    const left = floorPatchUVRect({ floorMaterialID: 'cobble-town', x: 0, y: 0, width: 128, height: 128 }, 1)
    const right = floorPatchUVRect(
      { floorMaterialID: 'cobble-town', x: 128, y: 0, width: 128, height: 128 },
      1
    )
    expect(left.origin.x + left.span.x).toBe(right.origin.x)
  })

  it('shrinks the V repeat for a non-square texture', () => {
    const square = floorPatchUVRect({ floorMaterialID: 'plank', x: 0, y: 0, width: 128, height: 128 }, 1)
    const strip = floorPatchUVRect({ floorMaterialID: 'plank', x: 0, y: 0, width: 128, height: 128 }, 0.5)
    expect(strip.span.y).toBeCloseTo(square.span.y * 2, 5)
    expect(strip.span.x).toBe(square.span.x)
  })
})

describe('scroll zoom', () => {
  it('clamps to the factor range', () => {
    expect(applyScrollZoom(1, 10_000)).toBe(2)
    expect(applyScrollZoom(1, -10_000)).toBe(0.5)
  })

  it('moves the same fraction at either clamp end', () => {
    const fromLow = applyScrollZoom(0.6, 10) / 0.6
    const fromHigh = applyScrollZoom(1.2, 10) / 1.2
    expect(fromLow).toBeCloseTo(fromHigh, 10)
  })
})
