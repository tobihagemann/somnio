import { describe, expect, it } from 'vitest'
import { SOMNIO_CONSTANTS } from '@/core/constants'
import type { Sector } from '@/core/sector'
import { captureClipboard, insertClipboard, validatedPaste } from '@/editor/clipboard'

/**
 * The clipboard over the in-page record buffer — anchor placement, duplicate offsets, Int16
 * clamps, stale-index skips, source-order capture, and the writer-round-trip paste gate —
 * with floor patches as a sixth kind.
 */

function sector(overrides: Partial<Sector> = {}): Sector {
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

describe('paste placement', () => {
  it('anchors the payload bounding corner at the cursor, preserving offsets', () => {
    const source = sector({
      objects: [
        { x: 64, y: 64, modelID: 'door', sourceWidth: 32, sourceHeight: 32, priority: 0, rotation: 0 },
      ],
      collisionMasks: [{ x: 96, y: 128, width: 32, height: 32 }],
    })
    const clipboard = captureClipboard(
      [
        { kind: 'object', index: 0 },
        { kind: 'mask', index: 0 },
      ],
      source
    )
    const target = sector()
    const inserted = insertClipboard(clipboard, target, { x: 200, y: 200 }, 32)
    expect(inserted.length).toBe(2)
    expect(target.objects[0]).toMatchObject({ x: 200, y: 200 })
    expect(target.collisionMasks[0]).toMatchObject({ x: 232, y: 264 })
  })

  it('offsets every clone by the fallback step on duplicate', () => {
    const body = sector({
      npcs: [
        {
          spawnOrigin: { x: 100, y: 100 },
          spawnBoxSize: { width: 32, height: 32 },
          maskSize: { width: 32, height: 48 },
          name: 'Libus',
          figure: 16,
          facing: 0,
          behaviorTag: 0,
          dialogScript: '',
        },
      ],
    })
    const clipboard = captureClipboard([{ kind: 'npc', index: 0 }], body)
    const inserted = insertClipboard(clipboard, body, undefined, 32)
    expect(inserted).toEqual([{ kind: 'npc', index: 1 }])
    expect(body.npcs[1]?.spawnOrigin).toEqual({ x: 132, y: 132 })
    expect(body.npcs[1]?.name).toBe(body.npcs[0]?.name)
  })

  it('clamps a paste at the Int16 limits instead of overflowing', () => {
    const source = sector({ collisionMasks: [{ x: 32_759, y: 32_759, width: 32, height: 32 }] })
    const clipboard = captureClipboard([{ kind: 'mask', index: 0 }], source)
    const target = sector()
    insertClipboard(clipboard, target, undefined, 32_767)
    expect(target.collisionMasks[0]).toMatchObject({ x: 32_767, y: 32_767 })
  })

  it('carries floor patches through capture and paste', () => {
    const source = sector({
      floorPatches: [{ floorMaterialID: 'cobble-town', x: 0, y: 0, width: 64, height: 64 }],
    })
    const clipboard = captureClipboard([{ kind: 'floorPatch', index: 0 }], source)
    const target = sector()
    const inserted = insertClipboard(clipboard, target, { x: 128, y: 128 }, 32)
    expect(inserted).toEqual([{ kind: 'floorPatch', index: 0 }])
    expect(target.floorPatches[0]).toMatchObject({ x: 128, y: 128, floorMaterialID: 'cobble-town' })
  })
})

describe('capture', () => {
  it('skips stale selection indices instead of throwing', () => {
    const source = sector({ collisionMasks: [{ x: 0, y: 0, width: 32, height: 32 }] })
    const clipboard = captureClipboard(
      [
        { kind: 'mask', index: 0 },
        { kind: 'mask', index: 7 },
        { kind: 'npc', index: 3 },
      ],
      source
    )
    expect(clipboard.collisionMasks).toEqual([{ x: 0, y: 0, width: 32, height: 32 }])
    expect(clipboard.npcs).toEqual([])
  })

  it('preserves source-array order so pasted stacking cannot shuffle', () => {
    const masks = [
      { x: 0, y: 0, width: 64, height: 64 },
      { x: 8, y: 8, width: 64, height: 64 },
      { x: 16, y: 16, width: 64, height: 64 },
    ]
    const source = sector({ collisionMasks: masks })
    const clipboard = captureClipboard(
      [
        { kind: 'mask', index: 2 },
        { kind: 'mask', index: 0 },
        { kind: 'mask', index: 1 },
      ],
      source
    )
    expect(clipboard.collisionMasks).toEqual(masks)
  })
})

describe('validatedPaste', () => {
  it('rejects a cap-busting payload through the writer round-trip gate', () => {
    const target = sector({
      collisionMasks: Array.from({ length: SOMNIO_CONSTANTS.maxSectorCollisionMasks }, () => ({
        x: 0,
        y: 0,
        width: 32,
        height: 32,
      })),
    })
    const clipboard = captureClipboard([{ kind: 'mask', index: 0 }], target)
    expect(validatedPaste(clipboard, target, { x: 64, y: 64 }, 32)).toBeUndefined()
  })

  it('rejects an empty clipboard and lands the happy path at the anchor', () => {
    const target = sector()
    expect(validatedPaste(captureClipboard([], target), target, { x: 64, y: 64 }, 32)).toBeUndefined()
    const source = sector({ collisionMasks: [{ x: 0, y: 0, width: 32, height: 32 }] })
    const clipboard = captureClipboard([{ kind: 'mask', index: 0 }], source)
    const pasted = validatedPaste(clipboard, target, { x: 64, y: 64 }, 32)
    expect(pasted?.sector.collisionMasks).toEqual([{ x: 64, y: 64, width: 32, height: 32 }])
    expect(pasted?.selection).toEqual([{ kind: 'mask', index: 0 }])
    // The gate works on a clone; the target itself is untouched.
    expect(target.collisionMasks).toEqual([])
  })
})
