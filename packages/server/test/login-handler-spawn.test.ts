import { describe, expect, it } from 'vitest'
import { arrivalSpawn } from '@somnio/core'
import { resolvedSpawn } from '../src/handlers/login.ts'
import { makeCharacter, makePortal, makeSector } from './support/sectorFactory.ts'

/** A 4 x 4 tile (512 px) sector; the center is (256, 256). */
function sector(masks: { x: number; y: number; width: number; height: number }[], portals = []) {
  return makeSector('S', { dimensions: { width: 4, height: 4 }, collisionMasks: masks, portals })
}

describe('resolvedSpawn', () => {
  it('is undefined when the persisted position is walkable', () => {
    expect(resolvedSpawn(makeCharacter({ x: 64, y: 64 }), sector([]))).toBeUndefined()
  })

  it('uses the arrival portal when the position is masked', () => {
    const target = makeSector('S', {
      dimensions: { width: 4, height: 4 },
      collisionMasks: [{ x: 0, y: 0, width: 8, height: 8 }],
      portals: [makePortal({ x: 64, y: 64, width: 128, height: 128 }, 'S', 'arrivalPlacement')],
    })
    const spawn = resolvedSpawn(makeCharacter({ x: 0, y: 0 }), target)
    expect(spawn).toBeDefined()
    expect(spawn).toEqual(arrivalSpawn(target))
  })

  it('falls back to the sector center without an arrival portal', () => {
    const target = sector([{ x: 0, y: 0, width: 8, height: 8 }])
    expect(resolvedSpawn(makeCharacter({ x: 0, y: 0 }), target)).toEqual({ x: 256, y: 256 })
  })

  it('falls back to the sector center when the arrival portal is fully masked', () => {
    const target = makeSector('S', {
      dimensions: { width: 4, height: 4 },
      collisionMasks: [{ x: 0, y: 0, width: 128, height: 128 }],
      portals: [makePortal({ x: 0, y: 0, width: 128, height: 128 }, 'S', 'arrivalPlacement')],
    })
    expect(arrivalSpawn(target)).toBeUndefined()
    expect(resolvedSpawn(makeCharacter({ x: 0, y: 0 }), target)).toEqual({ x: 256, y: 256 })
  })
})
