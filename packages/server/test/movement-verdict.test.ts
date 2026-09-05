import { describe, expect, it } from 'vitest'
import { anomalyLogDecision, movementReferenceVerdict } from '../src/world/perSectorActor.ts'

const origin = { x: 0, y: 0 }

describe('movementReferenceVerdict', () => {
  it('a short hop within the running budget is not flagged', () => {
    const verdict = movementReferenceVerdict(origin, { x: 10, y: 0 }, 0.05, 2, 128, 0.05)
    expect(verdict.distance).toBe(10)
    expect(verdict.exceeded).toBe(false)
  })

  it('a far hop over a tiny elapsed is flagged', () => {
    expect(movementReferenceVerdict(origin, { x: 1000, y: 0 }, 0.01, 2, 128, 0.05).exceeded).toBe(true)
  })

  it('a far hop over a long idle gap is not flagged', () => {
    expect(movementReferenceVerdict(origin, { x: 1000, y: 0 }, 10, 2, 128, 0.05).exceeded).toBe(false)
  })

  it('the min-elapsed floor caps a near-zero gap instead of shrinking to slack only', () => {
    // 150 * 0.05 * 2 + 128 = 143.
    const verdict = movementReferenceVerdict(origin, { x: 140, y: 0 }, 0, 2, 128, 0.05)
    expect(verdict.exceeded).toBe(false)
    expect(verdict.referenceCap).toBeCloseTo(143, 6)
  })

  it('a fractional sub-second elapsed contributes to the cap', () => {
    // 150 * 0.5 * 2 + 128 = 278.
    const verdict = movementReferenceVerdict(origin, { x: 200, y: 0 }, 0.5, 2, 128, 0.05)
    expect(verdict.exceeded).toBe(false)
    expect(verdict.referenceCap).toBeCloseTo(278, 6)
  })

  it('a move exactly at the reference cap is not flagged (strict greater-than boundary)', () => {
    const atCap = movementReferenceVerdict(origin, { x: 100, y: 0 }, 0, 2, 100, 0)
    const justOver = movementReferenceVerdict(origin, { x: 101, y: 0 }, 0, 2, 100, 0)
    expect(atCap.referenceCap).toBe(100)
    expect(atCap.exceeded).toBe(false)
    expect(justOver.exceeded).toBe(true)
  })

  it('the flat slack absorbs a small move at zero elapsed', () => {
    expect(movementReferenceVerdict(origin, { x: 100, y: 0 }, 0, 2, 128, 0).exceeded).toBe(false)
    expect(movementReferenceVerdict(origin, { x: 100, y: 0 }, 0, 2, 0, 0).exceeded).toBe(true)
  })
})

describe('anomalyLogDecision', () => {
  it('emits once per interval and coalesces suppressed counts', () => {
    const first = anomalyLogDecision(undefined, 0, 5)
    expect(first).toEqual({ shouldLog: true, suppressedSinceLast: 0, nextSuppressedCount: 0 })
    const second = anomalyLogDecision(1, 0, 5)
    expect(second.shouldLog).toBe(false)
    expect(second.nextSuppressedCount).toBe(1)
    const third = anomalyLogDecision(2, 1, 5)
    expect(third.shouldLog).toBe(false)
    expect(third.nextSuppressedCount).toBe(2)
    const fourth = anomalyLogDecision(6, 2, 5)
    expect(fourth).toEqual({ shouldLog: true, suppressedSinceLast: 2, nextSuppressedCount: 0 })
  })

  it('a gap exactly equal to the interval re-emits (gate is strict less-than)', () => {
    expect(anomalyLogDecision(5, 3, 5)).toEqual({
      shouldLog: true,
      suppressedSinceLast: 3,
      nextSuppressedCount: 0,
    })
  })
})
