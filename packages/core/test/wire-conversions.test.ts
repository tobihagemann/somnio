import { describe, expect, it } from 'vitest'
import { WIRE_HAND } from '@somnio/protocol'
import { HAND } from '../src/domain/inventoryRow.ts'
import type { InventoryRow } from '../src/domain/inventoryRow.ts'
import { SOMNIO_CONSTANTS } from '../src/constants.ts'
import { headingFromCardinal } from '../src/heading.ts'
import { PORTAL_DIRECTIONS, SectorConversionError, sectorFromWire } from '../src/sector.ts'
import type { Sector, SectorPortal } from '../src/sector.ts'
import { readSectorFile } from '../src/sectorFile.ts'
import {
  collisionMaskToWire,
  floorPatchToWire,
  gridSizeToWire,
  handFromWire,
  handToWire,
  inventoryExtraToWire,
  inventoryRowFromWire,
  inventoryRowToWire,
  lightSettingToWire,
  monsterSpawnToWire,
  npcToWire,
  objectToWire,
  portalToWire,
  sectorToWire,
} from '../src/wireConversions.ts'
import { SECTOR_FIXTURE_NAMES, readSectorFixture } from './support/sectorFixture.ts'

/**
 * Model ↔ wire round trips for every conversion. The non-trivial ones are the portal (direction
 * raw ↔ name), the NPC (nested origin ↔ flattened `spawnX`/`spawnY`), the inventory hand
 * (`undefined` ↔ wire `none`), and the sector's bounds guards on the way out.
 */

function makeSector(overrides: Partial<Sector> = {}): Sector {
  return {
    name: 'EdariaArena',
    version: 1,
    dimensions: { width: 16, height: 16 },
    floorMaterialID: 'stone-arena',
    light: { indoor: true, brightness: 75 },
    objects: [],
    collisionMasks: [],
    portals: [],
    npcs: [],
    monsterSpawns: [],
    floorPatches: [],
    ...overrides,
  }
}

function repeated<T>(count: number, value: T): T[] {
  return Array.from({ length: count }, () => structuredClone(value))
}

const OBJECT = { x: 1, y: 2, modelID: 'door', sourceWidth: 6, sourceHeight: 7, priority: 8, rotation: 0 }
const MASK = { x: 1, y: 2, width: 3, height: 4 }
const PATCH = { floorMaterialID: 'cobble-town', x: 1, y: 2, width: 3, height: 4 }
const PORTAL: SectorPortal = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  targetSectorName: 'EdariaMitte',
  direction: 'arrivalPlacement',
}
const NPC = {
  spawnOrigin: { x: 4, y: 5 },
  spawnBoxSize: { width: 2, height: 2 },
  maskSize: { width: 1, height: 1 },
  name: 'Libus',
  figure: 12,
  facing: 137.5,
  behaviorTag: 0,
  dialogScript: 'Hallo!',
}
const SPAWN = {
  spawnOrigin: { x: 1, y: 2 },
  spawnBoxSize: { width: 4, height: 4 },
  spawnedMonsterSize: { width: 1, height: 1 },
  name: 'Gespenst',
  figure: 99,
  bounded: true,
  spawnHP: 100,
  spawnBalance: 100,
  spawnMana: 100,
  aiScriptIndex: 3,
}

describe('per-type conversions', () => {
  it('converts points, sizes, and light settings', () => {
    expect(gridSizeToWire({ width: 10, height: 20 })).toEqual({ width: 10, height: 20 })
    expect(lightSettingToWire({ indoor: true, brightness: 75 })).toEqual({ indoor: true, brightness: 75 })
  })

  it('converts objects, masks, and floor patches', () => {
    expect(objectToWire(OBJECT)).toEqual(OBJECT)
    expect(collisionMaskToWire(MASK)).toEqual(MASK)
    expect(floorPatchToWire(PATCH)).toEqual(PATCH)
  })

  it('converts a portal to its direction raw and back', () => {
    for (const direction of Object.keys(PORTAL_DIRECTIONS) as (keyof typeof PORTAL_DIRECTIONS)[]) {
      const portal = { ...PORTAL, direction }
      const wire = portalToWire(portal)
      expect(wire.direction).toBe(PORTAL_DIRECTIONS[direction])
      expect(sectorFromWire(sectorToWire(makeSector({ portals: [portal] }))).portals).toEqual([portal])
    }
  })

  it('flattens an NPC and a monster spawn', () => {
    expect(npcToWire(NPC)).toEqual({
      spawnX: 4,
      spawnY: 5,
      spawnBoxWidth: 2,
      spawnBoxHeight: 2,
      maskWidth: 1,
      maskHeight: 1,
      name: 'Libus',
      figure: 12,
      direction: 137.5,
      behaviorTag: 0,
      dialogScript: 'Hallo!',
    })
    expect(monsterSpawnToWire(SPAWN)).toEqual({
      spawnX: 1,
      spawnY: 2,
      spawnBoxWidth: 4,
      spawnBoxHeight: 4,
      monsterWidth: 1,
      monsterHeight: 1,
      name: 'Gespenst',
      figure: 99,
      bounded: true,
      spawnHP: 100,
      spawnBalance: 100,
      spawnMana: 100,
      aiScriptIndex: 3,
    })
    const sector = sectorFromWire(sectorToWire(makeSector({ npcs: [NPC], monsterSpawns: [SPAWN] })))
    expect(sector.npcs).toEqual([NPC])
    expect(sector.monsterSpawns).toEqual([SPAWN])
  })
})

describe('inventory conversions', () => {
  it('round-trips an extra', () => {
    expect(inventoryExtraToWire({ key: 'gold', value: 42 })).toEqual({ key: 'gold', value: 42 })
  })

  it.each([undefined, HAND.left, HAND.right])('round-trips a row with hand %s', (hand) => {
    const row: InventoryRow = {
      slot: 7,
      category: 1,
      itemId: 99,
      extras: [{ key: 'gold', value: 50 }],
      equippedHand: hand,
    }
    expect(inventoryRowFromWire(inventoryRowToWire(row))).toEqual(row)
  })

  it('maps an unequipped hand to wire none and back', () => {
    expect(handToWire(undefined)).toBe(WIRE_HAND.none)
    expect(handFromWire(WIRE_HAND.none)).toBeUndefined()
    expect(handToWire(HAND.left)).toBe(WIRE_HAND.left)
    expect(handToWire(HAND.right)).toBe(WIRE_HAND.right)
    expect(handFromWire(WIRE_HAND.left)).toBe(HAND.left)
    expect(handFromWire(WIRE_HAND.right)).toBe(HAND.right)
  })
})

describe('sector conversions', () => {
  it('round-trips a hand-built sector', () => {
    const sector = makeSector({
      objects: [{ ...OBJECT, x: 1, y: 1, sourceWidth: 1, sourceHeight: 1, priority: 0 }],
      collisionMasks: [{ x: 0, y: 0, width: 1, height: 1 }],
      portals: [PORTAL],
    })
    expect(sectorFromWire(sectorToWire(sector))).toEqual(sector)
  })

  it.each(SECTOR_FIXTURE_NAMES)('%s survives disk -> wire -> model unchanged', (name) => {
    const sector = readSectorFile(readSectorFixture(name), name)
    expect(sectorFromWire(sectorToWire(sector))).toEqual(sector)
  })

  it('always emits rotation, floorPatches, and light on the wire', () => {
    const wire = sectorToWire(readSectorFile(readSectorFixture('EdariaMitte'), 'EdariaMitte'))
    expect(wire.objects.every((object) => 'rotation' in object)).toBe(true)
    expect('floorPatches' in wire).toBe(true)
    expect(wire.light).toEqual({ indoor: false, brightness: 100 })
    expect(wire.npcs[0]?.direction).toBe(headingFromCardinal('south'))
  })

  it('accepts dimensions at the boundary', () => {
    const height = SOMNIO_CONSTANTS.maxSectorArea / SOMNIO_CONSTANTS.maxSectorDimension
    const wire = sectorToWire(
      makeSector({ dimensions: { width: SOMNIO_CONSTANTS.maxSectorDimension, height } })
    )
    expect(wire.dimensions).toEqual({ width: SOMNIO_CONSTANTS.maxSectorDimension, height })
  })

  it.each([
    [0, 16],
    [-1, 16],
    [16, 0],
    [16, -1],
    [SOMNIO_CONSTANTS.maxSectorDimension + 1, 16],
    [16, SOMNIO_CONSTANTS.maxSectorDimension + 1],
    [512, 512],
  ])('refuses out-of-range dimensions %ix%i on the way out', (width, height) => {
    expect(() => sectorToWire(makeSector({ dimensions: { width, height } }))).toThrow(
      expect.objectContaining({ kind: 'sectorDimensionsOutOfRange' })
    )
  })

  it('accepts content counts at the caps', () => {
    const masks = SOMNIO_CONSTANTS.maxSectorAnchorScanPairings / SOMNIO_CONSTANTS.maxSectorObjects
    const wire = sectorToWire(
      makeSector({
        objects: repeated(SOMNIO_CONSTANTS.maxSectorObjects, OBJECT),
        collisionMasks: repeated(masks, MASK),
        portals: repeated(SOMNIO_CONSTANTS.maxSectorPortals, PORTAL),
        npcs: repeated(SOMNIO_CONSTANTS.maxSectorNPCs, NPC),
        monsterSpawns: repeated(SOMNIO_CONSTANTS.maxSectorMonsterSpawns, SPAWN),
        floorPatches: repeated(SOMNIO_CONSTANTS.maxSectorFloorPatches, PATCH),
      })
    )
    expect(wire.objects).toHaveLength(SOMNIO_CONSTANTS.maxSectorObjects)
    expect(wire.collisionMasks).toHaveLength(masks)
  })

  it.each([
    ['objects', { objects: repeated(SOMNIO_CONSTANTS.maxSectorObjects + 1, OBJECT) }],
    ['collision masks', { collisionMasks: repeated(SOMNIO_CONSTANTS.maxSectorCollisionMasks + 1, MASK) }],
    ['portals', { portals: repeated(SOMNIO_CONSTANTS.maxSectorPortals + 1, PORTAL) }],
    ['npcs', { npcs: repeated(SOMNIO_CONSTANTS.maxSectorNPCs + 1, NPC) }],
    ['monster spawns', { monsterSpawns: repeated(SOMNIO_CONSTANTS.maxSectorMonsterSpawns + 1, SPAWN) }],
    ['floor patches', { floorPatches: repeated(SOMNIO_CONSTANTS.maxSectorFloorPatches + 1, PATCH) }],
    [
      'the anchor-scan product',
      {
        objects: repeated(SOMNIO_CONSTANTS.maxSectorObjects, OBJECT),
        collisionMasks: repeated(
          SOMNIO_CONSTANTS.maxSectorAnchorScanPairings / SOMNIO_CONSTANTS.maxSectorObjects + 1,
          MASK
        ),
      },
    ],
  ] as const)('refuses %s over the cap on the way out', (_label, overrides) => {
    expect(() => sectorToWire(makeSector(overrides))).toThrow(
      expect.objectContaining({ kind: 'sectorContentCountsOutOfRange' })
    )
  })

  it('refuses an unknown portal direction on the way in', () => {
    const wire = sectorToWire(makeSector({ portals: [PORTAL] }))
    wire.portals[0]!.direction = 99
    expect(() => sectorFromWire(wire)).toThrow(SectorConversionError)
    expect(() => sectorFromWire(wire)).toThrow(expect.objectContaining({ kind: 'unknownPortalDirection' }))
  })
})
