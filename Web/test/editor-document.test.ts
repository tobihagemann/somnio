import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorDocument } from '@/editor/document'
import {
  DEFAULT_GRID_SNAP_PX,
  GRID_SNAP_PRESETS_PX,
  currentGridSnapPx,
  persistGridSnapPx,
  quantize,
  validSectorDimensions,
} from '@/editor/preferences'
import { readSectorFixture } from './helpers/sectorFixture'

/**
 * The document/undo model and the grid-snap preference: whole-body snapshots through one
 * funnel, deep-clone semantics, the saved-checkpoint dirty rule, and the grid-snap
 * absent-vs-zero guard.
 */

function initializedDocument(): EditorDocument {
  const document = new EditorDocument()
  document.create({
    name: 'Test',
    width: 4,
    height: 4,
    indoor: false,
    brightness: 100,
    floorMaterialID: 'grass-meadow',
  })
  return document
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response): void {
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init))
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('mutate / undo / redo', () => {
  it('is symmetric across N steps', () => {
    const document = initializedDocument()
    document.mutate('Place collision mask', (sector) => {
      sector.collisionMasks.push({ x: 0, y: 0, width: 32, height: 32 })
    })
    document.mutate('Move selection', (sector) => {
      sector.collisionMasks[0]!.x = 64
    })
    expect(document.sector.collisionMasks[0]?.x).toBe(64)
    document.undo()
    expect(document.sector.collisionMasks[0]?.x).toBe(0)
    document.undo()
    expect(document.sector.collisionMasks).toEqual([])
    document.redo()
    expect(document.sector.collisionMasks[0]?.x).toBe(0)
    document.redo()
    expect(document.sector.collisionMasks[0]?.x).toBe(64)
  })

  it('snapshots deeply, so a later nested mutation cannot edit history in place', () => {
    const document = initializedDocument()
    document.mutate('Place NPC', (sector) => {
      sector.npcs.push({
        spawnOrigin: { x: 10, y: 10 },
        spawnBoxSize: { width: 32, height: 32 },
        maskSize: { width: 32, height: 48 },
        name: 'N',
        figure: 0,
        facing: 0,
        behaviorTag: 0,
        dialogScript: '',
      })
    })
    document.mutate('Edit NPC', (sector) => {
      sector.npcs[0]!.spawnOrigin.x = 200
    })
    document.undo()
    expect(document.sector.npcs[0]?.spawnOrigin.x).toBe(10)
    document.redo()
    expect(document.sector.npcs[0]?.spawnOrigin.x).toBe(200)
  })

  it('clears the redo stack on a fresh mutation', () => {
    const document = initializedDocument()
    document.mutate('Place collision mask', (sector) => {
      sector.collisionMasks.push({ x: 0, y: 0, width: 32, height: 32 })
    })
    document.undo()
    document.mutate('Place sector portal', (sector) => {
      sector.portals.push({
        x: 0,
        y: 0,
        width: 32,
        height: 32,
        targetSectorName: '',
        direction: 'outboundTrigger',
      })
    })
    expect(document.canRedo).toBe(false)
  })
})

describe('dirty checkpoint', () => {
  it('derives dirty from the saved snapshot across save, mutate, undo, and redo', async () => {
    stubFetch(() => new Response(null, { status: 204 }))
    const document = initializedDocument()
    await document.save()
    expect(document.isDirty).toBe(false)
    document.mutate('Place collision mask', (sector) => {
      sector.collisionMasks.push({ x: 0, y: 0, width: 32, height: 32 })
    })
    expect(document.isDirty).toBe(true)
    // Undo back to the savepoint must read as clean again — a boolean flag cannot do this.
    document.undo()
    expect(document.isDirty).toBe(false)
    document.redo()
    expect(document.isDirty).toBe(true)
  })

  it('reports an uninitialized document as clean and a created one as dirty', () => {
    const document = new EditorDocument()
    expect(document.isUninitialized).toBe(true)
    expect(document.isDirty).toBe(false)
    document.create({
      name: 'Fresh',
      width: 2,
      height: 2,
      indoor: true,
      brightness: 60,
      floorMaterialID: 'wood-warm',
    })
    expect(document.isUninitialized).toBe(false)
    expect(document.isDirty).toBe(true)
    // A rename-only divergence counts: the name participates in the checkpoint.
    expect(document.sector.version).toBe(1)
  })
})

describe('file API round trips', () => {
  it('load preserves the file version and resets history and checkpoint', async () => {
    stubFetch(() => new Response(readSectorFixture('EdariaArena'), { status: 200 }))
    const document = new EditorDocument()
    await document.load('EdariaArena')
    expect(document.sector.name).toBe('EdariaArena')
    expect(document.sector.version).toBe(7)
    expect(document.isDirty).toBe(false)
    expect(document.canUndo).toBe(false)
  })

  it('save PUTs the serialized sector under its own name', async () => {
    const puts: { url: string; body: string }[] = []
    stubFetch((url, init) => {
      if (init?.method === 'PUT') {
        puts.push({ url, body: typeof init.body === 'string' ? init.body : '' })
        return new Response(null, { status: 204 })
      }
      return new Response(readSectorFixture('EdariaArena'), { status: 200 })
    })
    const document = new EditorDocument()
    await document.load('EdariaArena')
    await document.save()
    expect(puts.length).toBe(1)
    expect(puts[0]?.url).toContain('/__editor/sectors/EdariaArena')
    // An unedited save writes the exact committed bytes — the codec check under real use.
    expect(puts[0]?.body).toBe(readSectorFixture('EdariaArena'))
  })

  it('saveAs writes the new name and leaves the original in place', async () => {
    const puts: string[] = []
    stubFetch((url, init) => {
      if (init?.method === 'PUT') {
        puts.push(url)
        return new Response(null, { status: 204 })
      }
      return new Response(readSectorFixture('EdariaArena'), { status: 200 })
    })
    const document = new EditorDocument()
    await document.load('EdariaArena')
    await document.saveAs('ArenaCopy')
    expect(document.sector.name).toBe('ArenaCopy')
    expect(puts).toEqual([`/__editor/sectors/${encodeURIComponent('ArenaCopy')}`])
  })

  it('keeps the checkpoint when a save fails', async () => {
    stubFetch(() => new Response('boom', { status: 500 }))
    const document = initializedDocument()
    await expect(document.save()).rejects.toThrow(/saving/)
    expect(document.isDirty).toBe(true)
  })

  it('stays dirty when an edit lands during the save PUT', async () => {
    const document = new EditorDocument()
    stubFetch((_url, init) => {
      if (init?.method === 'PUT') {
        // Editing stays enabled during the await; this edit is not in the body being written.
        document.mutate('edit during save', (sector) => {
          sector.light.brightness = 50
        })
        return new Response(null, { status: 204 })
      }
      return new Response(readSectorFixture('EdariaArena'), { status: 200 })
    })
    await document.load('EdariaArena')
    await document.save()
    // The checkpoint is the snapshot that was PUT, not the mid-flight edit — so it reads dirty.
    expect(document.isDirty).toBe(true)
  })

  it('rolls the name back when Save As fails to write', async () => {
    stubFetch((_url, init) => {
      if (init?.method === 'PUT') return new Response('boom', { status: 500 })
      return new Response(readSectorFixture('EdariaArena'), { status: 200 })
    })
    const document = new EditorDocument()
    await document.load('EdariaArena')
    await expect(document.saveAs('ArenaCopy')).rejects.toThrow(/saving/)
    // The rename bypasses `mutate`, so a failed write must restore the name by hand.
    expect(document.sector.name).toBe('EdariaArena')
  })
})

describe('preferences', () => {
  it('quantizes toward zero with a free-step identity', () => {
    expect(quantize(67, 32)).toBe(64)
    expect(quantize(50, 16)).toBe(48)
    expect(quantize(15, 8)).toBe(8)
    expect(quantize(13, 4)).toBe(12)
    expect(quantize(64, 32)).toBe(64)
    expect(quantize(67, 0)).toBe(67)
    expect(quantize(-33, 32)).toBe(-32)
    expect(quantize(-1, 4)).toBe(-0)
  })

  it('mirrors the codec dimension gate at its boundaries', () => {
    expect(validSectorDimensions(0, 1)).toBe(false)
    expect(validSectorDimensions(1, 0)).toBe(false)
    expect(validSectorDimensions(1, 1)).toBe(true)
    expect(validSectorDimensions(1025, 1)).toBe(false)
    expect(validSectorDimensions(1024, 1)).toBe(true)
    expect(validSectorDimensions(1024, 65)).toBe(false)
    expect(validSectorDimensions(1024, 64)).toBe(true)
    expect(validSectorDimensions(256, 256)).toBe(true)
    expect(validSectorDimensions(256, 257)).toBe(false)
  })

  it('falls back to 32 for an absent key, never to free', () => {
    // `free` is stored as `0`, so the absent-vs-zero distinction is the whole point.
    const empty = new Map<string, string>()
    const storage = {
      getItem: (key: string) => empty.get(key) ?? null,
      setItem: (key: string, value: string) => void empty.set(key, value),
    }
    expect(currentGridSnapPx(storage)).toBe(DEFAULT_GRID_SNAP_PX)
    persistGridSnapPx(0, storage)
    expect(currentGridSnapPx(storage)).toBe(0)
    persistGridSnapPx(16, storage)
    expect(currentGridSnapPx(storage)).toBe(16)
  })

  it('falls back to 32 for an unknown stored value', () => {
    const storage = { getItem: () => '17' }
    expect(currentGridSnapPx(storage)).toBe(DEFAULT_GRID_SNAP_PX)
  })

  it('pins the grid-snap presets to their documented literals', () => {
    // A runtime pin, not a self-referential one: `as const` only pins the derived type, so a raw
    // value edit (`[32, 16, 8, 4, 0]` -> anything else) would pass a type-shaped assertion.
    expect([...GRID_SNAP_PRESETS_PX]).toEqual([32, 16, 8, 4, 0])
    expect(DEFAULT_GRID_SNAP_PX).toBe(32)
  })

  it('keeps the session grid-snap when the store write throws', () => {
    // The production path (no explicit storage arg) reads/writes real `localStorage`; stub it to
    // throw on write and confirm the selection survives in memory rather than snapping to 32.
    const original = globalThis.localStorage
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('blocked')
      },
    } as unknown as Storage
    Object.defineProperty(globalThis, 'localStorage', { value: throwing, configurable: true })
    try {
      persistGridSnapPx(8)
      expect(currentGridSnapPx()).toBe(8)
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true })
    }
  })
})
