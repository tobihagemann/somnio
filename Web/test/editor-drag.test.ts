import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { headingFromCardinal, angularDistance } from '@/core/heading'
import type { Sector, SectorNPC } from '@/core/sector'
import * as drag from '@/editor/dragController'
import { EditorDocument } from '@/editor/document'
import { applyFramingToCamera, editorFramingFittingPixelBounds } from '@/editor/framing'
import { screenAtFloorPixel } from '@/editor/picking'
import type { ScreenPoint, ViewportSize } from '@/editor/picking'
import { removeAllSelections } from '@/editor/selection'
import type { EditorSelection } from '@/editor/selection'

/**
 * The drag controller — session classification, delta quantization, resize clamping,
 * placement seeds, handle hit-testing, facing rotation, marquee SAT, and the commit guards
 * that keep no-op gestures off the undo stack.
 */

const VIEWPORT: ViewportSize = { width: 640, height: 480 }
const DEFAULTS: drag.PlacementDefaults = { objectModelID: 'door', floorMaterialID: 'grass-meadow' }

function context(gridStep = 32): drag.DragContext {
  const framing = editorFramingFittingPixelBounds({ x: 0, y: 0 }, { x: 512, y: 512 }, VIEWPORT)
  const camera = new THREE.OrthographicCamera()
  applyFramingToCamera(camera, framing, VIEWPORT)
  return { camera, viewport: VIEWPORT, gridStep }
}

/** The press/drag location a user aiming at a legacy pixel would produce. */
function viewportPoint(pixel: { x: number; y: number }, dragContext: drag.DragContext): ScreenPoint {
  return screenAtFloorPixel(dragContext.camera, dragContext.viewport, pixel)
}

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

function npc(origin: { x: number; y: number }, facing = headingFromCardinal('south')): SectorNPC {
  return {
    spawnOrigin: origin,
    spawnBoxSize: { width: 32, height: 32 },
    maskSize: { width: 32, height: 48 },
    name: 'Libus',
    figure: 16,
    facing,
    behaviorTag: 0,
    dialogScript: '',
  }
}

/** Document seeded with a body, for the `endSession` orchestration tests. */
function documentWith(body: Sector): EditorDocument {
  const document = new EditorDocument()
  document.mutate('Create new map', (draft) => {
    Object.assign(draft, structuredClone(body))
  })
  return document
}

describe('move', () => {
  it('quantizes a drag delta to the grid step, preserving relative offsets', () => {
    const ctx = context(32)
    const delta = drag.gridDelta(
      viewportPoint({ x: 100, y: 100 }, ctx),
      viewportPoint({ x: 140, y: 30 }, ctx),
      ctx
    )
    expect(delta).toEqual({ dx: 32, dy: -64 })
  })

  it('keeps a free-snap drag delta pixel-exact', () => {
    const ctx = context(0)
    const delta = drag.gridDelta(
      viewportPoint({ x: 100, y: 100 }, ctx),
      viewportPoint({ x: 103, y: 95 }, ctx),
      ctx
    )
    expect(delta).toEqual({ dx: 3, dy: -5 })
  })

  it('shifts every snapshotted origin by the same delta in a group move', () => {
    const body = sector({
      objects: [{ x: 0, y: 0, modelID: 'door', sourceWidth: 32, sourceHeight: 32, priority: 0, rotation: 0 }],
      npcs: [npc({ x: 100, y: 100 })],
    })
    const originals = drag.origins(
      [
        { kind: 'object', index: 0 },
        { kind: 'npc', index: 0 },
      ],
      body
    )
    drag.applyMove(originals, 64, -32, body)
    expect(body.objects[0]).toMatchObject({ x: 64, y: -32 })
    expect(body.npcs[0]?.spawnOrigin).toEqual({ x: 164, y: 68 })
  })

  it('clamps a move at the Int16 limits instead of overflowing', () => {
    const body = sector({ collisionMasks: [{ x: 32_766, y: -32_767, width: 32, height: 32 }] })
    const originals = drag.origins([{ kind: 'mask', index: 0 }], body)
    drag.applyMove(originals, 10_000, -10_000, body)
    expect(body.collisionMasks[0]).toMatchObject({ x: 32_767, y: -32_768 })
  })
})

describe('resize', () => {
  it('grows the record in place from the bottom-right handle', () => {
    const bounds = drag.resizedBounds({ x: 64, y: 64 }, { width: 32, height: 32 }, 'bottomRight', 32, 64, 32)
    expect(bounds).toEqual({ origin: { x: 64, y: 64 }, size: { width: 64, height: 96 } })
  })

  it('shifts the origin and shrinks the extent from the top-left handle', () => {
    const bounds = drag.resizedBounds({ x: 64, y: 64 }, { width: 96, height: 96 }, 'topLeft', 32, 32, 32)
    expect(bounds).toEqual({ origin: { x: 96, y: 96 }, size: { width: 64, height: 64 } })
  })

  it('clamps at the minimum extent past the opposite edge', () => {
    const bounds = drag.resizedBounds({ x: 64, y: 64 }, { width: 96, height: 96 }, 'right', -500, 0, 32)
    expect(bounds).toEqual({ origin: { x: 64, y: 64 }, size: { width: 32, height: 96 } })
  })

  it('clamps a resize at the Int16 limits instead of overflowing', () => {
    const bounds = drag.resizedBounds(
      { x: 32_767 - 32, y: 0 },
      { width: 32, height: 32 },
      'bottomRight',
      40_000,
      40_000,
      1
    )
    expect(bounds.origin).toEqual({ x: 32_767 - 32, y: 0 })
    expect(bounds.size.width).toBe(32)
    expect(bounds.origin.y + bounds.size.height).toBe(32_767)
  })

  it('keeps the minimum extent when the fixed edge sits at the domain limit', () => {
    const bounds = drag.resizedBounds({ x: 32_767, y: 0 }, { width: 8, height: 8 }, 'right', 100, 0, 32)
    expect(bounds.size.width).toBeGreaterThanOrEqual(32)
  })

  it('keeps the opposite edge fixed through an over-limit resize', () => {
    const original = { origin: { x: -32_768 + 8, y: 0 }, size: { width: 32, height: 32 } }
    const bounds = drag.resizedBounds(original.origin, original.size, 'left', -40_000, 0, 1)
    expect(bounds.origin.x + bounds.size.width).toBe(original.origin.x + original.size.width)
    expect(bounds.origin.x).toBe(-32_768)
  })

  it('writes an NPC handle resize to the spawn box', () => {
    const body = sector({ npcs: [npc({ x: 100, y: 100 })] })
    drag.applyBounds({ kind: 'npc', index: 0 }, { x: 90, y: 90 }, { width: 64, height: 48 }, body)
    expect(body.npcs[0]?.spawnOrigin).toEqual({ x: 90, y: 90 })
    expect(body.npcs[0]?.spawnBoxSize).toEqual({ width: 64, height: 48 })
  })
})

describe('placement', () => {
  it('drops the default one-tile footprint on a tap', () => {
    const ctx = context(32)
    const press = viewportPoint({ x: 130, y: 98 }, ctx)
    const bounds = drag.placementBounds('mask', { x: 128, y: 96 }, press, press, ctx)
    expect(bounds).toEqual({ origin: { x: 128, y: 96 }, size: drag.DEFAULT_FOOTPRINT })
  })

  it('rubber-bands the quantized footprint on a drag', () => {
    const ctx = context(32)
    const bounds = drag.placementBounds(
      'mask',
      { x: 128, y: 96 },
      viewportPoint({ x: 128, y: 96 }, ctx),
      viewportPoint({ x: 230, y: 170 }, ctx),
      ctx
    )
    expect(bounds).toEqual({ origin: { x: 128, y: 96 }, size: { width: 96, height: 64 } })
  })

  it('normalizes a backwards rubber band with one snap step minimum', () => {
    const bounds = drag.rubberBandBounds({ x: 128, y: 96 }, { x: 96, y: 96 }, 32)
    expect(bounds).toEqual({ origin: { x: 96, y: 96 }, size: { width: 32, height: 32 } })
  })

  it.each(['object', 'mask', 'portal', 'npc', 'monster', 'floorPatch'] as const)(
    'direct %s placement appends the default record and selects it',
    (tool) => {
      const body = sector()
      const placed = drag.placeRecord(tool, { x: 64, y: 64 }, { ...drag.DEFAULT_FOOTPRINT }, body, DEFAULTS)
      expect(placed).toBeDefined()
      switch (placed!.kind) {
        case 'object':
          expect(body.objects[placed!.index]?.modelID).toBe(DEFAULTS.objectModelID)
          expect(body.objects[placed!.index]?.priority).toBe(0)
          break
        case 'portal':
          expect(body.portals[placed!.index]?.targetSectorName).toBe('')
          expect(body.portals[placed!.index]?.direction).toBe('outboundTrigger')
          break
        case 'npc':
          expect(body.npcs[placed!.index]?.facing).toBe(headingFromCardinal('south'))
          break
        case 'monsterSpawn':
          expect(body.monsterSpawns[placed!.index]?.spawnHP).toBe(100)
          expect(body.monsterSpawns[placed!.index]?.bounded).toBe(true)
          break
        case 'floorPatch':
          expect(body.floorPatches[placed!.index]?.floorMaterialID).toBe(DEFAULTS.floorMaterialID)
          break
        case 'mask':
          break
      }
    }
  )
})

describe('handles', () => {
  it('resolves the pressed handle by its projected screen rect', () => {
    const ctx = context()
    const origin = { x: 64, y: 64 }
    const size = { width: 128, height: 128 }
    expect(drag.hitHandle(viewportPoint({ x: 192, y: 192 }, ctx), origin, size, ctx)).toBe('bottomRight')
    expect(drag.hitHandle(viewportPoint({ x: 400, y: 400 }, ctx), origin, size, ctx)).toBeUndefined()
  })

  it('places the facing handle past the spawn box along the heading', () => {
    const handle = drag.facingHandlePixel(
      { x: 100, y: 100 },
      { width: 32, height: 32 },
      headingFromCardinal('east'),
      24
    )
    // Center (116, 116) + east direction x (half extent 16 + clearance 24).
    expect(handle.x).toBeCloseTo(156, 3)
    expect(handle.y).toBeCloseTo(116, 3)
  })
})

describe('rotate', () => {
  it.each(['south', 'east', 'north', 'west'] as const)(
    'a facing drag toward %s lands on its exact degrees',
    (direction) => {
      const ctx = context()
      const subject = npc({ x: 100, y: 100 })
      const center = drag.spawnBoxCenter(subject.spawnOrigin, subject.spawnBoxSize)
      const offset = {
        south: { x: 0, y: 100 },
        east: { x: 100, y: 0 },
        north: { x: 0, y: -100 },
        west: { x: -100, y: 0 },
      }[direction]
      const heading = drag.headingFromDrag(
        viewportPoint({ x: center.x + offset.x, y: center.y + offset.y }, ctx),
        subject,
        ctx
      )
      expect(Math.abs(angularDistance(heading, headingFromCardinal(direction)))).toBeLessThan(0.5)
    }
  )

  it('normalizes a drag across the north-south seam into the half-open range', () => {
    const ctx = context()
    const subject = npc({ x: 100, y: 100 })
    const center = drag.spawnBoxCenter(subject.spawnOrigin, subject.spawnBoxSize)
    const heading = drag.headingFromDrag(
      viewportPoint({ x: center.x - 1, y: center.y + 200 }, ctx),
      subject,
      ctx
    )
    expect(heading).toBeGreaterThanOrEqual(0)
    expect(heading).toBeLessThan(360)
    expect(Math.abs(angularDistance(heading, 0))).toBeLessThan(2)
  })
})

describe('marquee', () => {
  function boundingBox(corners: ScreenPoint[]): { x: number; y: number; width: number; height: number } {
    const xs = corners.map((corner) => corner.x)
    const ys = corners.map((corner) => corner.y)
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    }
  }

  it('selects records whose projected quads intersect it', () => {
    const ctx = context()
    const body = sector({
      objects: [{ x: 0, y: 0, modelID: 'door', sourceWidth: 32, sourceHeight: 32, priority: 0, rotation: 0 }],
      collisionMasks: [{ x: 400, y: 400, width: 32, height: 32 }],
    })
    const corners = drag.projectedCorners({ x: 0, y: 0 }, { width: 32, height: 32 }, ctx)
    const box = boundingBox(corners)
    const hits = drag.marqueeSelections(
      body,
      { x: box.x - 4, y: box.y - 4, width: box.width + 8, height: box.height + 8 },
      ctx
    )
    expect(hits).toEqual([{ kind: 'object', index: 0 }])
    const empty = drag.marqueeSelections(body, { x: -50, y: -50, width: 10, height: 10 }, ctx)
    expect(empty).toEqual([])
  })

  it('selects nothing inside the projected bounding box but outside the quad', () => {
    // The tilted camera projects a floor rect to a rotated quad; a marquee in the dead
    // corner of its bounding box must not select the record.
    const ctx = context()
    const portal = {
      x: 0,
      y: 32,
      width: 256,
      height: 288,
      targetSectorName: 'EdariaBibliothek',
      direction: 'arrivalPlacement' as const,
    }
    const body = sector({ portals: [portal] })
    const corners = drag.projectedCorners({ x: 0, y: 32 }, { width: 256, height: 288 }, ctx)
    const box = boundingBox(corners)
    const deadCorner = { x: box.x + 1, y: box.y + 1, width: 2, height: 2 }
    expect(drag.rectIntersectsConvexQuad(deadCorner, corners)).toBe(false)
    expect(drag.marqueeSelections(body, deadCorner, ctx)).toEqual([])
  })
})

describe('session classification', () => {
  it('begins a resize session on a selected record handle', () => {
    const ctx = context()
    const body = sector({ collisionMasks: [{ x: 64, y: 64, width: 128, height: 128 }] })
    const begun = drag.beginSession(
      viewportPoint({ x: 192, y: 192 }, ctx),
      'select',
      false,
      body,
      [{ kind: 'mask', index: 0 }],
      ctx
    )
    expect(begun.session).toEqual({
      kind: 'resize',
      selection: { kind: 'mask', index: 0 },
      handle: 'bottomRight',
      origin: { x: 64, y: 64 },
      size: { width: 128, height: 128 },
    })
    expect(begun.selection).toEqual([{ kind: 'mask', index: 0 }])
  })

  it('begins a rotate session on a selected NPC facing handle', () => {
    const ctx = context()
    const subject = npc({ x: 200, y: 200 })
    const body = sector({ npcs: [subject] })
    const pxPerPt = drag.legacyPixelsPerViewportPoint(ctx)
    const handlePixel = drag.facingHandlePixel(
      subject.spawnOrigin,
      subject.spawnBoxSize,
      subject.facing,
      drag.FACING_CLEARANCE_PT * pxPerPt
    )
    const begun = drag.beginSession(
      viewportPoint(handlePixel, ctx),
      'select',
      false,
      body,
      [{ kind: 'npc', index: 0 }],
      ctx
    )
    expect(begun.session).toEqual({ kind: 'rotate', npcIndex: 0 })
  })

  it('toggles membership on shift-click and starts no session', () => {
    const ctx = context()
    const body = sector({
      collisionMasks: [
        { x: 0, y: 0, width: 64, height: 64 },
        { x: 200, y: 200, width: 64, height: 64 },
      ],
    })
    const press = viewportPoint({ x: 230, y: 230 }, ctx)
    const added = drag.beginSession(press, 'select', true, body, [{ kind: 'mask', index: 0 }], ctx)
    expect(added.session).toBeUndefined()
    expect(added.selection).toEqual([
      { kind: 'mask', index: 0 },
      { kind: 'mask', index: 1 },
    ])
    const removed = drag.beginSession(press, 'select', true, body, added.selection, ctx)
    expect(removed.session).toBeUndefined()
    expect(removed.selection).toEqual([{ kind: 'mask', index: 0 }])
  })

  it('moves the whole selection when pressing a selected record', () => {
    const ctx = context()
    const body = sector({
      collisionMasks: [
        { x: 0, y: 0, width: 64, height: 64 },
        { x: 200, y: 200, width: 64, height: 64 },
      ],
    })
    const selection: EditorSelection[] = [
      { kind: 'mask', index: 0 },
      { kind: 'mask', index: 1 },
    ]
    const begun = drag.beginSession(
      viewportPoint({ x: 30, y: 30 }, ctx),
      'select',
      false,
      body,
      selection,
      ctx
    )
    expect(begun.session?.kind).toBe('move')
    if (begun.session?.kind === 'move') {
      expect(begun.session.originals.map((entry) => entry.selection)).toEqual(selection)
    }
    expect(begun.selection).toEqual(selection)
  })

  it('retargets the selection before moving when pressing an unselected record', () => {
    const ctx = context()
    const body = sector({
      collisionMasks: [
        { x: 0, y: 0, width: 64, height: 64 },
        { x: 200, y: 200, width: 64, height: 64 },
      ],
    })
    const begun = drag.beginSession(
      viewportPoint({ x: 230, y: 230 }, ctx),
      'select',
      false,
      body,
      [{ kind: 'mask', index: 0 }],
      ctx
    )
    expect(begun.session?.kind).toBe('move')
    expect(begun.selection).toEqual([{ kind: 'mask', index: 1 }])
  })

  it('lets the topmost record under the press win over the selection beneath it', () => {
    const ctx = context()
    const body = sector({
      collisionMasks: [{ x: 0, y: 0, width: 256, height: 256 }],
      npcs: [npc({ x: 100, y: 100 })],
    })
    const begun = drag.beginSession(
      viewportPoint({ x: 110, y: 110 }, ctx),
      'select',
      false,
      body,
      [{ kind: 'mask', index: 0 }],
      ctx
    )
    expect(begun.session?.kind).toBe('move')
    expect(begun.selection).toEqual([{ kind: 'npc', index: 0 }])
  })

  it('clears the selection and starts a marquee on empty ground', () => {
    const ctx = context()
    const body = sector({
      portals: [
        {
          x: 0,
          y: 32,
          width: 256,
          height: 288,
          targetSectorName: 'EdariaBibliothek',
          direction: 'arrivalPlacement',
        },
      ],
    })
    // Legacy (319, 235) sits outside the portal rect but inside its projected bounding box.
    const begun = drag.beginSession(
      viewportPoint({ x: 319, y: 235 }, ctx),
      'select',
      false,
      body,
      [{ kind: 'portal', index: 0 }],
      ctx
    )
    expect(begun.session).toEqual({ kind: 'marquee' })
    expect(begun.selection).toEqual([])
  })
})

describe('group delete', () => {
  it('removes exactly the selected records regardless of set order', () => {
    const body = sector({
      collisionMasks: [
        { x: 0, y: 0, width: 32, height: 32 },
        { x: 100, y: 0, width: 32, height: 32 },
        { x: 200, y: 0, width: 32, height: 32 },
      ],
      npcs: [npc({ x: 0, y: 0 }), npc({ x: 100, y: 100 })],
    })
    removeAllSelections(
      [
        { kind: 'mask', index: 0 },
        { kind: 'mask', index: 2 },
        { kind: 'npc', index: 1 },
      ],
      body
    )
    expect(body.collisionMasks).toEqual([{ x: 100, y: 0, width: 32, height: 32 }])
    expect(body.npcs.length).toBe(1)
    expect(body.npcs[0]?.spawnOrigin).toEqual({ x: 0, y: 0 })
  })
})

describe('commit guards', () => {
  it('commits no mutation and registers no undo step on a zero-travel move', () => {
    const ctx = context()
    const document = documentWith(sector({ collisionMasks: [{ x: 64, y: 64, width: 64, height: 64 }] }))
    const before = document.undoDepth
    const press = viewportPoint({ x: 80, y: 80 }, ctx)
    drag.endSession(
      { kind: 'move', originals: [{ selection: { kind: 'mask', index: 0 }, origin: { x: 64, y: 64 } }] },
      press,
      press,
      false,
      document,
      document.sector,
      [{ kind: 'mask', index: 0 }],
      ctx,
      DEFAULTS
    )
    expect(document.sector.collisionMasks[0]).toEqual({ x: 64, y: 64, width: 64, height: 64 })
    expect(document.undoDepth).toBe(before)
  })

  it('appends, selects, and registers one undo step on a placement commit', () => {
    const ctx = context()
    const document = documentWith(sector())
    const before = document.undoDepth
    const press = viewportPoint({ x: 70, y: 70 }, ctx)
    const selection = drag.endSession(
      { kind: 'placement', tool: 'mask', anchor: { x: 64, y: 64 } },
      press,
      press,
      false,
      document,
      document.sector,
      [],
      ctx,
      DEFAULTS
    )
    expect(document.sector.collisionMasks).toEqual([{ x: 64, y: 64, width: 128, height: 128 }])
    expect(selection).toEqual([{ kind: 'mask', index: 0 }])
    expect(document.undoDepth).toBe(before + 1)
  })

  it('commits no mutation on a zero-travel resize', () => {
    const ctx = context()
    const mask = { x: 64, y: 64, width: 64, height: 64 }
    const document = documentWith(sector({ collisionMasks: [mask] }))
    const before = document.undoDepth
    const press = viewportPoint({ x: 128, y: 128 }, ctx)
    drag.endSession(
      {
        kind: 'resize',
        selection: { kind: 'mask', index: 0 },
        handle: 'bottomRight',
        origin: { x: 64, y: 64 },
        size: { width: 64, height: 64 },
      },
      press,
      press,
      false,
      document,
      document.sector,
      [],
      ctx,
      DEFAULTS
    )
    expect(document.sector.collisionMasks[0]).toEqual(mask)
    expect(document.undoDepth).toBe(before)
  })

  it('commits no undo step on a rotate back to the current heading', () => {
    const ctx = context()
    const subject = npc({ x: 100, y: 100 })
    const document = documentWith(sector({ npcs: [subject] }))
    const before = document.undoDepth
    const center = drag.spawnBoxCenter(subject.spawnOrigin, subject.spawnBoxSize)
    const handle = viewportPoint({ x: center.x, y: center.y + 60 }, ctx)
    drag.endSession(
      { kind: 'rotate', npcIndex: 0 },
      handle,
      handle,
      false,
      document,
      document.sector,
      [],
      ctx,
      DEFAULTS
    )
    expect(document.sector.npcs[0]?.facing).toBe(subject.facing)
    expect(document.undoDepth).toBe(before)
  })

  it('neither throws nor mutates on a rotate against a stale NPC index', () => {
    const ctx = context()
    const document = documentWith(sector())
    const before = structuredClone(document.sector)
    const depth = document.undoDepth
    drag.endSession(
      { kind: 'rotate', npcIndex: 5 },
      viewportPoint({ x: 100, y: 100 }, ctx),
      viewportPoint({ x: 200, y: 200 }, ctx),
      false,
      document,
      document.sector,
      [],
      ctx,
      DEFAULTS
    )
    expect(document.sector).toEqual(before)
    expect(document.undoDepth).toBe(depth)
  })

  it('unions an additive marquee with the existing selection', () => {
    const ctx = context()
    const document = documentWith(
      sector({
        collisionMasks: [
          { x: 0, y: 0, width: 32, height: 32 },
          { x: 400, y: 400, width: 32, height: 32 },
        ],
      })
    )
    const corners = drag.projectedCorners({ x: 400, y: 400 }, { width: 32, height: 32 }, ctx)
    const xs = corners.map((corner) => corner.x)
    const ys = corners.map((corner) => corner.y)
    const start = { x: Math.min(...xs) - 4, y: Math.min(...ys) - 4 }
    const end = { x: Math.max(...xs) + 4, y: Math.max(...ys) + 4 }
    const selection = drag.endSession(
      { kind: 'marquee' },
      start,
      end,
      true,
      document,
      document.sector,
      [{ kind: 'mask', index: 0 }],
      ctx,
      DEFAULTS
    )
    expect(selection).toEqual([
      { kind: 'mask', index: 0 },
      { kind: 'mask', index: 1 },
    ])
  })
})
