import { describe, expect, it } from 'vitest'
import { headingFromCardinal } from '@/core/heading'
import type { Sector } from '@/core/sector'
import { candidateSelections, nudgeDelta, selectRecord } from '@/editor/canvasController'
import {
  isValidSelection,
  removeAllSelections,
  selectionBounds,
  selectionsEqual,
  toggleSelection,
} from '@/editor/selection'
import type { EditorSelection } from '@/editor/selection'
import { CursorReadout } from '@/editor/ui/cursorReadout'

/**
 * Selection, cursor-readout, pick-ordering, and nudge cases — over six kinds, floor patches
 * included.
 */

function populatedSector(): Sector {
  return {
    name: 'Test',
    version: 1,
    dimensions: { width: 4, height: 4 },
    floorMaterialID: 'grass-meadow',
    light: { indoor: false, brightness: 100 },
    objects: [{ x: 0, y: 0, modelID: 'door', sourceWidth: 32, sourceHeight: 32, priority: 0, rotation: 0 }],
    collisionMasks: [{ x: 0, y: 0, width: 32, height: 32 }],
    portals: [{ x: 0, y: 0, width: 32, height: 32, targetSectorName: 'Other', direction: 'outboundTrigger' }],
    npcs: [
      {
        spawnOrigin: { x: 1, y: 1 },
        spawnBoxSize: { width: 16, height: 16 },
        maskSize: { width: 8, height: 8 },
        name: 'N',
        figure: 0,
        facing: headingFromCardinal('south'),
        behaviorTag: 0,
        dialogScript: '',
      },
    ],
    monsterSpawns: [
      {
        spawnOrigin: { x: 2, y: 2 },
        spawnBoxSize: { width: 16, height: 16 },
        spawnedMonsterSize: { width: 8, height: 8 },
        name: 'M',
        figure: 0,
        bounded: true,
        spawnHP: 1,
        spawnBalance: 1,
        spawnMana: 1,
        aiScriptIndex: 0,
      },
    ],
    floorPatches: [{ floorMaterialID: 'cobble-town', x: 3, y: 3, width: 16, height: 16 }],
  }
}

const ALL_KINDS = ['object', 'mask', 'portal', 'npc', 'monsterSpawn', 'floorPatch'] as const

describe('selection validity and bounds', () => {
  it.each(ALL_KINDS)('a valid %s selection reports valid and resolves bounds', (kind) => {
    const selection: EditorSelection = { kind, index: 0 }
    expect(isValidSelection(selection, populatedSector())).toBe(true)
    expect(selectionBounds(selection, populatedSector())).toBeDefined()
  })

  it.each(ALL_KINDS)('an out-of-range %s selection reports invalid with no bounds', (kind) => {
    const selection: EditorSelection = { kind, index: 99 }
    expect(isValidSelection(selection, populatedSector())).toBe(false)
    expect(selectionBounds(selection, populatedSector())).toBeUndefined()
  })
})

describe('removeAllSelections', () => {
  it('removes a valid selection record', () => {
    const sector = populatedSector()
    removeAllSelections([{ kind: 'object', index: 0 }], sector)
    expect(sector.objects).toEqual([])
  })

  it('skips stale indices and leaves the body unchanged', () => {
    const sector = populatedSector()
    const before = structuredClone(sector)
    removeAllSelections([{ kind: 'npc', index: 99 }], sector)
    expect(sector).toEqual(before)
  })

  it('covers every kind', () => {
    const sector = populatedSector()
    removeAllSelections(
      ALL_KINDS.map((kind): EditorSelection => ({ kind, index: 0 })),
      sector
    )
    expect(sector.objects).toEqual([])
    expect(sector.collisionMasks).toEqual([])
    expect(sector.portals).toEqual([])
    expect(sector.npcs).toEqual([])
    expect(sector.monsterSpawns).toEqual([])
    expect(sector.floorPatches).toEqual([])
  })
})

describe('set helpers', () => {
  it('toggles membership and compares order-independently', () => {
    const list: EditorSelection[] = [{ kind: 'mask', index: 0 }]
    const added = toggleSelection(list, { kind: 'object', index: 0 })
    expect(added.length).toBe(2)
    const removed = toggleSelection(added, { kind: 'mask', index: 0 })
    expect(removed).toEqual([{ kind: 'object', index: 0 }])
    expect(
      selectionsEqual(
        [
          { kind: 'mask', index: 0 },
          { kind: 'object', index: 1 },
        ],
        [
          { kind: 'object', index: 1 },
          { kind: 'mask', index: 0 },
        ]
      )
    ).toBe(true)
  })
})

describe('pick ordering', () => {
  it('prefers spawns over rects and the latest record within a kind', () => {
    const overlap: Sector = {
      ...populatedSector(),
      objects: [
        { x: 0, y: 0, modelID: 'door', sourceWidth: 256, sourceHeight: 256, priority: 0, rotation: 0 },
      ],
      collisionMasks: [
        { x: 0, y: 0, width: 128, height: 128 },
        { x: 0, y: 0, width: 128, height: 128 },
      ],
      portals: [],
      npcs: [
        {
          spawnOrigin: { x: 32, y: 32 },
          spawnBoxSize: { width: 32, height: 32 },
          maskSize: { width: 32, height: 32 },
          name: 'N',
          figure: 0,
          facing: headingFromCardinal('south'),
          behaviorTag: 0,
          dialogScript: '',
        },
      ],
      monsterSpawns: [
        {
          spawnOrigin: { x: 32, y: 32 },
          spawnBoxSize: { width: 32, height: 32 },
          spawnedMonsterSize: { width: 32, height: 32 },
          name: 'M',
          figure: 0,
          bounded: true,
          spawnHP: 1,
          spawnBalance: 1,
          spawnMana: 1,
          aiScriptIndex: 0,
        },
      ],
      floorPatches: [],
    }
    // Inside NPC + monster + mask + object: the NPC wins.
    expect(selectRecord({ x: 40, y: 40 }, overlap, 'select')).toEqual({ kind: 'npc', index: 0 })
    // Inside both masks + the object: the most-recently-placed mask wins.
    expect(selectRecord({ x: 100, y: 100 }, overlap, 'select')).toEqual({ kind: 'mask', index: 1 })
    // Inside only the object.
    expect(selectRecord({ x: 200, y: 200 }, overlap, 'select')).toEqual({ kind: 'object', index: 0 })
    // A placement tool restricts picking to its own kind.
    expect(selectRecord({ x: 40, y: 40 }, overlap, 'monster')).toEqual({ kind: 'monsterSpawn', index: 0 })
  })

  it('orders candidates npcs, monsters, portals, masks, objects, floor patches', () => {
    const kinds = candidateSelections(populatedSector(), 'select').map((selection) => selection.kind)
    expect(kinds).toEqual(['npc', 'monsterSpawn', 'portal', 'mask', 'object', 'floorPatch'])
  })

  it('selects a floor patch under its own tool and last under select', () => {
    const sector: Sector = {
      ...populatedSector(),
      npcs: [],
      monsterSpawns: [],
      portals: [],
      collisionMasks: [{ x: 0, y: 0, width: 32, height: 32 }],
      floorPatches: [{ floorMaterialID: 'cobble-town', x: 0, y: 0, width: 64, height: 64 }],
    }
    // Under the patch tool the patch is pickable anywhere in its rect.
    expect(selectRecord({ x: 40, y: 40 }, sector, 'floorPatch')).toEqual({ kind: 'floorPatch', index: 0 })
    // Under Select, the overlapping mask wins — patches sit last, below masks.
    expect(selectRecord({ x: 10, y: 10 }, sector, 'select')).toEqual({ kind: 'mask', index: 0 })
    // Clear of the mask, the patch is reachable under Select too.
    expect(selectRecord({ x: 40, y: 40 }, sector, 'select')).toEqual({ kind: 'floorPatch', index: 0 })
  })
})

describe('nudgeDelta', () => {
  it('maps arrow keys to 1px legacy-axis deltas', () => {
    expect(nudgeDelta('ArrowUp', false, 8)).toEqual({ dx: 0, dy: -1 })
    expect(nudgeDelta('ArrowDown', false, 8)).toEqual({ dx: 0, dy: 1 })
    expect(nudgeDelta('ArrowLeft', false, 8)).toEqual({ dx: -1, dy: 0 })
    expect(nudgeDelta('ArrowRight', false, 8)).toEqual({ dx: 1, dy: 0 })
  })

  it('scales the nudge to the grid step with a 1px floor under shift', () => {
    expect(nudgeDelta('ArrowRight', true, 16)).toEqual({ dx: 16, dy: 0 })
    expect(nudgeDelta('ArrowDown', true, 0)).toEqual({ dx: 0, dy: 1 })
  })

  it('resolves no nudge for a non-arrow key', () => {
    expect(nudgeDelta(' ', false, 8)).toBeUndefined()
  })
})

describe('CursorReadout', () => {
  it('tracks a single selection record size', () => {
    const readout = new CursorReadout()
    readout.applyBounds([{ kind: 'mask', index: 0 }], populatedSector())
    expect(readout.width).toBe(32)
    expect(readout.height).toBe(32)
  })

  it('clears the size readout for a multi-selection', () => {
    const readout = new CursorReadout()
    readout.applyBounds([{ kind: 'mask', index: 0 }], populatedSector())
    readout.applyBounds(
      [
        { kind: 'mask', index: 0 },
        { kind: 'object', index: 0 },
      ],
      populatedSector()
    )
    expect(readout.width).toBe(0)
    expect(readout.height).toBe(0)
  })

  it('clears the size readout for an empty or stale selection', () => {
    const readout = new CursorReadout()
    readout.applyBounds([{ kind: 'mask', index: 0 }], populatedSector())
    readout.applyBounds([], populatedSector())
    expect(readout.width).toBe(0)
    expect(readout.height).toBe(0)
    readout.applyBounds([{ kind: 'mask', index: 9 }], populatedSector())
    expect(readout.width).toBe(0)
    expect(readout.height).toBe(0)
  })
})
