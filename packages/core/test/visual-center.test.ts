import { describe, expect, it } from 'vitest'
import { SOMNIO_CONSTANTS } from '../src/constants.ts'
import { isWithin, squaredDistance } from '../src/visualCenter.ts'

describe('visual center', () => {
  it('includes the boundary at exactly the radius', () => {
    expect(isWithin({ x: 0, y: 0 }, { x: 64, y: 0 }, SOMNIO_CONSTANTS.npcInteractionRadius)).toBe(true)
  })

  it('rejects a point beyond the monster aggro radius', () => {
    // Squared distance 73728 against a radius squared of 36864.
    expect(isWithin({ x: 0, y: 0 }, { x: 192, y: 192 }, SOMNIO_CONSTANTS.monsterAggroRadius)).toBe(false)
  })

  it('handles just inside and just outside the radius', () => {
    expect(isWithin({ x: 0, y: 0 }, { x: 100, y: 0 }, 100)).toBe(true)
    expect(isWithin({ x: 0, y: 0 }, { x: 101, y: 0 }, 100)).toBe(false)
  })

  it('stays exact for centers near the Int32 limit', () => {
    const max = 2_147_483_647
    expect(squaredDistance({ x: 0, y: 0 }, { x: max, y: max })).toBe(2 * max * max)
  })
})
