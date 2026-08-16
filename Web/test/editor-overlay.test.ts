import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthoringOverlay } from '@/editor/authoringOverlay'
import { EditorShell } from '@/editor/editorShell'
import type { Sector } from '@/core/sector'

/**
 * The authoring overlay (rebuild-from-scratch child counts, the grid-line cap, the zero-extent
 * guard) and the Esc state table — the latter through a headless `EditorShell`, which also
 * smoke-tests the whole composition without a renderer.
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

describe('AuthoringOverlay', () => {
  it('renders record rects and the selection, rebuilt from scratch each update', () => {
    const overlay = new AuthoringOverlay()
    const body = sector({
      collisionMasks: [{ x: 0, y: 0, width: 32, height: 32 }],
      portals: [
        { x: 64, y: 0, width: 32, height: 16, targetSectorName: 'Other', direction: 'outboundTrigger' },
      ],
      npcs: [
        {
          spawnOrigin: { x: 96, y: 96 },
          spawnBoxSize: { width: 32, height: 48 },
          maskSize: { width: 32, height: 48 },
          name: 'Libus',
          figure: 16,
          facing: 0,
          behaviorTag: 0,
          dialogScript: '',
        },
      ],
      monsterSpawns: [
        {
          spawnOrigin: { x: 160, y: 160 },
          spawnBoxSize: { width: 64, height: 64 },
          spawnedMonsterSize: { width: 32, height: 48 },
          name: 'Gespenst',
          figure: 0,
          bounded: false,
          spawnHP: 100,
          spawnBalance: 100,
          spawnMana: 100,
          aiScriptIndex: 0,
        },
      ],
      floorPatches: [{ floorMaterialID: 'cobble-town', x: 0, y: 128, width: 64, height: 64 }],
    })
    overlay.update({
      sector: body,
      selectionBounds: [{ origin: { x: 0, y: 0 }, size: { width: 32, height: 32 } }],
      showGrid: false,
      gridStepPx: 32,
    })
    // Patch + mask + portal + NPC spawn + monster spawn rects + the selection border.
    expect(overlay._childCount()).toBe(6)

    overlay.update({ sector: body, selectionBounds: [], showGrid: false, gridStepPx: 32 })
    // Rebuilt from scratch: the selection is gone.
    expect(overlay._childCount()).toBe(5)
  })

  it('adds one grid container with a line per step across both axes', () => {
    const overlay = new AuthoringOverlay()
    const body = sector()
    overlay.update({ sector: body, selectionBounds: [], showGrid: true, gridStepPx: 32 })
    expect(overlay._childCount()).toBe(1)
    // A 4x4-tile sector spans 512 px: 17 vertical + 17 horizontal lines at the 32 px step.
    expect(overlay._gridLineCount()).toBe(34)
    overlay.update({ sector: body, selectionBounds: [], showGrid: false, gridStepPx: 32 })
    expect(overlay._childCount()).toBe(0)
    expect(overlay._gridLineCount()).toBeUndefined()
  })

  it('suppresses a grid past the line cap instead of stalling the rebuild', () => {
    const overlay = new AuthoringOverlay()
    // 12x12 tiles at the finest 4 px snap would emit (1536+1536)/4 + 2 = 770 planes.
    const body = sector({ dimensions: { width: 12, height: 12 } })
    overlay.update({ sector: body, selectionBounds: [], showGrid: true, gridStepPx: 4 })
    expect(overlay._childCount()).toBe(0)
    expect(overlay._gridLineCount()).toBeUndefined()
  })

  it('renders an empty placeholder for a zero-extent record instead of a degenerate plane', () => {
    const overlay = new AuthoringOverlay()
    const body = sector({ collisionMasks: [{ x: 0, y: 0, width: 0, height: 32 }] })
    overlay.update({ sector: body, selectionBounds: [], showGrid: false, gridStepPx: 32 })
    expect(overlay._childCount()).toBe(1)
    expect(overlay.root.children[0]?.children.length).toBe(0)
  })
})

describe('Esc state machine', () => {
  function makeShell(): EditorShell {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify([]), { status: 200 })))
    const container = document.createElement('div')
    document.body.append(container)
    return new EditorShell({ container, startRendering: false })
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('consumes Esc on the picker floor over an uninitialized document', () => {
    const shell = makeShell()
    expect(shell.presentedOverlay).toBe('sectorPicker')
    shell.handleEscape()
    expect(shell.presentedOverlay).toBe('sectorPicker')
  })

  it('backs the picker and new-map overlays out to the game menu once initialized', () => {
    const shell = makeShell()
    shell.document.create({
      name: 'Test',
      width: 4,
      height: 4,
      indoor: false,
      brightness: 100,
      floorMaterialID: 'grass-meadow',
    })
    shell.present('sectorPicker')
    shell.handleEscape()
    expect(shell.presentedOverlay).toBe('gameMenu')
    shell.present('newMap')
    shell.handleEscape()
    expect(shell.presentedOverlay).toBe('gameMenu')
  })

  it.each(['sectorSettings', 'about', 'preferences', 'saveAs'] as const)(
    'backs %s out to the game menu',
    (overlay) => {
      const shell = makeShell()
      shell.present(overlay)
      shell.handleEscape()
      expect(shell.presentedOverlay).toBe('gameMenu')
    }
  )

  it('dismisses the game menu back to the canvas', () => {
    const shell = makeShell()
    shell.present('gameMenu')
    shell.handleEscape()
    expect(shell.presentedOverlay).toBeUndefined()
  })

  it('removes the selection in one undo step on delete, and no-ops under an overlay', () => {
    const shell = makeShell()
    shell.document.create({
      name: 'Test',
      width: 4,
      height: 4,
      indoor: false,
      brightness: 100,
      floorMaterialID: 'grass-meadow',
    })
    shell.document.mutate('Place collision mask', (draft) => {
      draft.collisionMasks.push({ x: 0, y: 0, width: 32, height: 32 })
    })
    shell.selection = [{ kind: 'mask', index: 0 }]
    // The modal host swallows pointer input only; the command handlers stay wired
    // underneath, so the gate must live in the shared delete path.
    shell.present('gameMenu')
    const depth = shell.document.undoDepth
    shell.deleteSelection()
    expect(shell.document.sector.collisionMasks.length).toBe(1)
    expect(shell.document.undoDepth).toBe(depth)
    shell.present(undefined)
    shell.deleteSelection()
    expect(shell.document.sector.collisionMasks).toEqual([])
    expect(shell.selection).toEqual([])
    expect(shell.document.undoDepth).toBe(depth + 1)
  })

  it('clears a live selection before the game menu opens', () => {
    const shell = makeShell()
    shell.document.create({
      name: 'Test',
      width: 4,
      height: 4,
      indoor: false,
      brightness: 100,
      floorMaterialID: 'grass-meadow',
    })
    shell.document.mutate('Place collision mask', (draft) => {
      draft.collisionMasks.push({ x: 0, y: 0, width: 32, height: 32 })
    })
    shell.present(undefined)
    shell.selection = [{ kind: 'mask', index: 0 }]
    shell.handleEscape()
    expect(shell.selection).toEqual([])
    expect(shell.presentedOverlay).toBeUndefined()
    shell.handleEscape()
    expect(shell.presentedOverlay).toBe('gameMenu')
  })
})

describe('floor-patch overlap commit gate', () => {
  function makeShell(): EditorShell {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify([]), { status: 200 })))
    const container = document.createElement('div')
    document.body.append(container)
    const shell = new EditorShell({ container, startRendering: false })
    shell.document.create({
      name: 'Test',
      width: 8,
      height: 8,
      indoor: false,
      brightness: 100,
      floorMaterialID: 'grass-meadow',
    })
    shell.present(undefined)
    return shell
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  function seedTwoFlushPatches(shell: EditorShell): void {
    // Two flush (non-overlapping — exclusive edges) patches; nudging the first one pixel right
    // slides it over the second.
    shell.document.mutate('seed', (sector) => {
      sector.floorPatches = [
        { floorMaterialID: 'cobble-town', x: 0, y: 0, width: 32, height: 32 },
        { floorMaterialID: 'cobble-town', x: 32, y: 0, width: 32, height: 32 },
      ]
    })
  }

  it('refuses a nudge that introduces an overlap, leaving the patch in place', () => {
    const shell = makeShell()
    seedTwoFlushPatches(shell)
    shell.selection = [{ kind: 'floorPatch', index: 0 }]
    const depthBefore = shell.document.undoDepth
    shell.nudgeSelection('ArrowRight', false)
    expect(shell.document.sector.floorPatches[0]?.x).toBe(0)
    expect(shell.document.undoDepth).toBe(depthBefore)
  })

  it('allows a nudge that does not introduce an overlap', () => {
    const shell = makeShell()
    seedTwoFlushPatches(shell)
    shell.selection = [{ kind: 'floorPatch', index: 0 }]
    shell.nudgeSelection('ArrowLeft', false)
    expect(shell.document.sector.floorPatches[0]?.x).toBe(-1)
  })

  it('still edits a file that already carries an overlap, refusing only a new one', () => {
    const shell = makeShell()
    // A legacy layout with one existing overlap plus a separate flush pair.
    shell.document.mutate('seed', (sector) => {
      sector.floorPatches = [
        { floorMaterialID: 'cobble-town', x: 0, y: 0, width: 32, height: 32 },
        { floorMaterialID: 'cobble-town', x: 16, y: 0, width: 32, height: 32 },
        { floorMaterialID: 'cobble-town', x: 128, y: 0, width: 32, height: 32 },
        { floorMaterialID: 'cobble-town', x: 160, y: 0, width: 32, height: 32 },
      ]
    })
    // Nudging the isolated third patch away introduces no new overlap -> allowed.
    shell.selection = [{ kind: 'floorPatch', index: 2 }]
    shell.nudgeSelection('ArrowUp', false)
    expect(shell.document.sector.floorPatches[2]?.y).toBe(-1)
    // But sliding it onto the fourth would add a second overlap -> refused.
    shell.document.mutate('reset', (sector) => {
      sector.floorPatches[2]!.y = 0
    })
    shell.selection = [{ kind: 'floorPatch', index: 2 }]
    for (let i = 0; i < 32; i += 1) shell.nudgeSelection('ArrowRight', false)
    expect(shell.document.sector.floorPatches[2]?.x).toBe(128)
  })

  it('refuses an edit that trades one overlap for a different one (subset, not count)', () => {
    const shell = makeShell()
    // A and B overlap; C is flush with B. Nudging B one pixel right resolves A-B but creates
    // B-C, keeping the overlap count at 1 — a count comparison would wrongly allow it.
    shell.document.mutate('seed', (sector) => {
      sector.floorPatches = [
        { floorMaterialID: 'cobble-town', x: 0, y: 0, width: 32, height: 32 },
        { floorMaterialID: 'cobble-town', x: 31, y: 0, width: 32, height: 32 },
        { floorMaterialID: 'cobble-town', x: 63, y: 0, width: 32, height: 32 },
      ]
    })
    shell.selection = [{ kind: 'floorPatch', index: 1 }]
    shell.nudgeSelection('ArrowRight', false)
    expect(shell.document.sector.floorPatches[1]?.x).toBe(31)
  })
})
