import { describe, expect, it } from 'vitest'
import {
  PORTAL_DIRECTIONS,
  SectorConversionError,
  arrivalSpawn,
  isWalkable,
  portalTriggerRects,
  sectorFromWire,
  sectorPixelCenter,
  sectorPixelHeight,
  sectorPixelWidth,
} from '@/core/sector'
import { SOMNIO_CONSTANTS } from '@/core/constants'
import { swiftEnumCases } from './helpers/swiftEnum'
import type { WireSector } from '@/protocol'

/**
 * Mirrors the hostile-input boundary from `Sector(_ wire:)`. These bounds are what keep a
 * malicious or corrupt `enterSector` from driving an unbounded tile-map allocation, or the
 * quadratic objects x collisionMasks anchor scan that would lock the main thread for seconds.
 */

function makeWireSector(overrides: Partial<WireSector> = {}): WireSector {
  return {
    name: 'EdariaMitte',
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

function repeated<T>(count: number, make: (index: number) => T): T[] {
  return Array.from({ length: count }, (_unused, index) => make(index))
}

describe('sector dimension bounds', () => {
  it('accepts a normal sector', () => {
    expect(sectorFromWire(makeWireSector()).dimensions).toEqual({ width: 4, height: 4 })
  })

  it.each([
    [0, 4],
    [4, 0],
    [-1, 4],
    [SOMNIO_CONSTANTS.maxSectorDimension + 1, 1],
    [1, SOMNIO_CONSTANTS.maxSectorDimension + 1],
  ])('rejects dimensions %ix%i', (width, height) => {
    expect(() => sectorFromWire(makeWireSector({ dimensions: { width, height } }))).toThrow(
      SectorConversionError
    )
  })

  /**
   * The per-axis cap alone still admits 1024x1024, whose tile map is ~16.7M cells. The area cap
   * is what actually bounds the allocation.
   */
  it('rejects an in-axis sector whose area exceeds the cap', () => {
    expect(() => sectorFromWire(makeWireSector({ dimensions: { width: 1024, height: 1024 } }))).toThrow(
      /out of range/
    )
    expect(() => sectorFromWire(makeWireSector({ dimensions: { width: 256, height: 256 } }))).not.toThrow()
  })
})

describe('sector content-count bounds', () => {
  it('rejects an object array past its cap', () => {
    const objects = repeated(SOMNIO_CONSTANTS.maxSectorObjects + 1, () => ({
      x: 0,
      y: 0,
      modelID: 'barrel',
      sourceWidth: 32,
      sourceHeight: 32,
      priority: 0,
      rotation: 0,
    }))
    expect(() => sectorFromWire(makeWireSector({ objects }))).toThrow(/content counts out of range/)
  })

  /**
   * Both arrays can sit under their own caps while their product still drives ~16.7M anchor-scan
   * pairings, which is the cost the pairing cap exists to bound.
   */
  it('rejects a pairing product past the cap even when each array is within its own cap', () => {
    const objects = repeated(2048, () => ({
      x: 0,
      y: 0,
      modelID: 'barrel',
      sourceWidth: 32,
      sourceHeight: 32,
      priority: 0,
      rotation: 0,
    }))
    const collisionMasks = repeated(2048, () => ({ x: 0, y: 0, width: 1, height: 1 }))
    expect(objects.length).toBeLessThanOrEqual(SOMNIO_CONSTANTS.maxSectorObjects)
    expect(collisionMasks.length).toBeLessThanOrEqual(SOMNIO_CONSTANTS.maxSectorCollisionMasks)
    expect(objects.length * collisionMasks.length).toBeGreaterThan(
      SOMNIO_CONSTANTS.maxSectorAnchorScanPairings
    )
    expect(() => sectorFromWire(makeWireSector({ objects, collisionMasks }))).toThrow(
      /content counts out of range/
    )
  })
})

describe('portal direction', () => {
  it('rejects an unknown raw direction rather than defaulting it', () => {
    const portals = [{ x: 0, y: 0, width: 8, height: 8, targetSectorName: 'X', direction: 7 }]
    expect(() => sectorFromWire(makeWireSector({ portals }))).toThrow(/unknownPortalDirection\(7\)/)
  })

  it('maps the known raw directions', () => {
    const sector = sectorFromWire(
      makeWireSector({
        portals: [
          { x: 0, y: 0, width: 8, height: 8, targetSectorName: 'A', direction: 0 },
          { x: 8, y: 0, width: 8, height: 8, targetSectorName: 'B', direction: 1 },
        ],
      })
    )
    expect(sector.portals.map((portal) => portal.direction)).toEqual(['outboundTrigger', 'arrivalPlacement'])
  })

  /**
   * Pins the raw values to the Swift enum they mirror, because nothing else in the suite can. Both
   * sides encode and decode with their own constant, so a swapped pair round-trips cleanly through
   * the codec tests, the golden frames, and every case above that spells the names symbolically —
   * and only shows up in play, as a sector whose arrival area is treated as one giant portal
   * trigger that blocks every step the player takes inside it.
   */
  it('matches the raw values of Swift PortalDirection', () => {
    const cases = swiftEnumCases('Sources/SomnioCore/Models/SectorPortal.swift', 'PortalDirection')
    expect(Object.keys(cases).length).toBe(Object.keys(PORTAL_DIRECTIONS).length)
    expect(cases).toEqual(PORTAL_DIRECTIONS)
  })
})

/** Spelled symbolically so these fixtures survive any future change to the raw encoding. */
const TRIGGER = PORTAL_DIRECTIONS.outboundTrigger
const ARRIVAL = PORTAL_DIRECTIONS.arrivalPlacement

describe('portalTriggerRects keeps the full-array offset', () => {
  /**
   * The server indexes `staticSector.portals[portalIndex]` against the **full** array, so the
   * trigger filter must preserve the original offset. Re-enumerating the filtered list sends the
   * wrong index and teleports the player through the wrong portal.
   */
  it('reports offsets in the full portals array, not the filtered one', () => {
    const sector = sectorFromWire(
      makeWireSector({
        portals: [
          { x: 0, y: 0, width: 8, height: 8, targetSectorName: 'self', direction: ARRIVAL },
          { x: 16, y: 0, width: 8, height: 8, targetSectorName: 'A', direction: TRIGGER },
          { x: 32, y: 0, width: 8, height: 8, targetSectorName: 'self', direction: ARRIVAL },
          { x: 48, y: 0, width: 8, height: 8, targetSectorName: 'B', direction: TRIGGER },
        ],
      })
    )
    expect(portalTriggerRects(sector).map((trigger) => trigger.index)).toEqual([1, 3])
  })
})

describe('sector geometry', () => {
  it('computes pixel extents from tiles', () => {
    const sector = sectorFromWire(makeWireSector({ dimensions: { width: 4, height: 3 } }))
    expect(sectorPixelWidth(sector)).toBe(512)
    expect(sectorPixelHeight(sector)).toBe(384)
    expect(sectorPixelCenter(sector)).toEqual({ x: 256, y: 192 })
  })

  it('treats a masked pixel as unwalkable and an in-bounds clear pixel as walkable', () => {
    const sector = sectorFromWire(
      makeWireSector({ collisionMasks: [{ x: 100, y: 100, width: 32, height: 32 }] })
    )
    expect(isWalkable(sector, { x: 10, y: 10 })).toBe(true)
    expect(isWalkable(sector, { x: 100, y: 100 })).toBe(false)
    expect(isWalkable(sector, { x: 132, y: 100 })).toBe(true)
    expect(isWalkable(sector, { x: -1, y: 10 })).toBe(false)
    expect(isWalkable(sector, { x: 512, y: 10 })).toBe(false)
  })
})

describe('arrivalSpawn', () => {
  it('is undefined without a self-pointing arrival portal', () => {
    expect(arrivalSpawn(sectorFromWire(makeWireSector()))).toBeUndefined()
  })

  it('prefers the portal centre when it is walkable', () => {
    const sector = sectorFromWire(
      makeWireSector({
        portals: [
          {
            x: 100,
            y: 100,
            width: 64,
            height: 64,
            targetSectorName: 'EdariaMitte',
            direction: ARRIVAL,
          },
        ],
      })
    )
    expect(arrivalSpawn(sector)).toEqual({ x: 132, y: 132 })
  })

  /**
   * Swift halves an `Int32`, which truncates. Every portal in today's fixtures is an even width, so
   * `trunc` and `round` agree everywhere and swapping them changes nothing — but the editor lets an
   * author draw an odd rect, and rounding up would then place the arrival one pixel from where the
   * server puts it.
   */
  it('truncates an odd portal extent when halving it, as Int32 division does', () => {
    const sector = sectorFromWire(
      makeWireSector({
        portals: [
          { x: 100, y: 100, width: 65, height: 65, targetSectorName: 'EdariaMitte', direction: ARRIVAL },
        ],
      })
    )
    // 100 + trunc(32.5) = 132. Rounding would give 133.
    expect(arrivalSpawn(sector)).toEqual({ x: 132, y: 132 })
  })

  /**
   * The portal rect can span collision masks (a bookshelf row crossing it), so a blocked centre
   * falls back to the walkable cell closest to it rather than dropping the player into geometry.
   */
  it('scans for the nearest walkable cell when the centre is blocked', () => {
    const sector = sectorFromWire(
      makeWireSector({
        portals: [
          { x: 100, y: 100, width: 64, height: 64, targetSectorName: 'EdariaMitte', direction: ARRIVAL },
        ],
        collisionMasks: [{ x: 128, y: 128, width: 16, height: 16 }],
      })
    )
    // The exact cell, not merely a walkable one: the rect holds dozens of walkable cells, so
    // `toBeDefined` + `isWalkable` also hold for a scan that returns the first one it meets
    // (100,100) instead of the nearest. That drops an arriving player at the far corner of the
    // portal, which for an inbound-facing rect is straight back onto an outbound trigger.
    expect(arrivalSpawn(sector)).toEqual({ x: 132, y: 124 })
    expect(isWalkable(sector, arrivalSpawn(sector)!)).toBe(true)
  })

  /**
   * The scan granularity itself, which the fixture above cannot see: at (100,100,64,64) with a
   * 16 px mask, step 8 and step 4 pick the same cell, so halving the step leaves that test green.
   * Swift fixes `let step: Int32 = 8` (`Sector.swift`), and a browser that scanned on a finer
   * lattice would stand an arriving player somewhere the server does not expect.
   */
  it('scans on the same 8 px lattice as the Swift original', () => {
    const sector = sectorFromWire(
      makeWireSector({
        portals: [
          { x: 100, y: 100, width: 32, height: 32, targetSectorName: 'EdariaMitte', direction: ARRIVAL },
        ],
        // Blocks the centre only, so the scan runs and every lattice cell around it is walkable.
        collisionMasks: [{ x: 116, y: 116, width: 1, height: 1 }],
      })
    )
    // Centre is (116,116); the nearest cell the 8 px lattice reaches is 8 px away. A 4 px scan
    // would find (116,112) at half that distance and return it instead.
    expect(arrivalSpawn(sector)).toEqual({ x: 116, y: 108 })
  })

  /**
   * A portal whose centre is *off* the scan lattice, which every fixture above misses: the scan
   * starts at `portal.x` and steps 8, so an even-width rect starting on a multiple of 8 always puts
   * the centre on a visited cell and the nearest walkable one is unique. Real content is not so
   * tidy — `EdariaInn` ships `{x: 144, width: 72}`, centre 180, and the scan visits 176 and 184,
   * both exactly 4 px away. Which of the two wins is then decided by `distance < bestDistance`
   * being strict, and nothing pinned that: relaxing it to `<=` moves an arriving player 8 px and
   * the whole suite stays green.
   */
  it('breaks a lattice tie toward the first cell in scan order', () => {
    const sector = sectorFromWire(
      makeWireSector({
        // EdariaInn's shipped inbound rect, so the arithmetic is content-realistic and not chosen
        // to make a tie appear.
        portals: [
          { x: 144, y: 96, width: 72, height: 80, targetSectorName: 'EdariaMitte', direction: ARRIVAL },
        ],
        // Blocks the centre alone, so the scan runs over an otherwise walkable rect.
        collisionMasks: [{ x: 180, y: 136, width: 1, height: 1 }],
      })
    )

    // Centre is (180,136). y is on the lattice, x is not: 176 and 184 tie at 4 px, and the scan
    // reaches 176 first.
    expect(arrivalSpawn(sector)).toEqual({ x: 176, y: 136 })
    // The tie is real rather than incidental to this fixture.
    expect(Math.abs(176 - 180)).toBe(Math.abs(184 - 180))
    expect(isWalkable(sector, { x: 184, y: 136 })).toBe(true)
  })

  it('is undefined when the whole portal rect is blocked', () => {
    const sector = sectorFromWire(
      makeWireSector({
        portals: [
          { x: 100, y: 100, width: 64, height: 64, targetSectorName: 'EdariaMitte', direction: ARRIVAL },
        ],
        collisionMasks: [{ x: 100, y: 100, width: 64, height: 64 }],
      })
    )
    expect(arrivalSpawn(sector)).toBeUndefined()
  })
})

describe('NPC facing normalises through Heading', () => {
  it('folds an out-of-range persisted direction rather than carrying it raw', () => {
    const sector = sectorFromWire(
      makeWireSector({
        npcs: [
          {
            spawnX: 0,
            spawnY: 0,
            spawnBoxWidth: 32,
            spawnBoxHeight: 32,
            maskWidth: 32,
            maskHeight: 48,
            name: 'Libus',
            figure: 16,
            direction: 450,
            behaviorTag: 0,
            dialogScript: '',
          },
        ],
      })
    )
    expect(sector.npcs[0]!.facing).toBe(90)
  })
})
