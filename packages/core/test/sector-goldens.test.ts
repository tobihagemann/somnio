import { describe, expect, it } from 'vitest'
import { headingFromCardinal } from '../src/heading.ts'
import type { SectorPortal } from '../src/sector.ts'
import { readSectorFile, writeSectorFile } from '../src/sectorFile.ts'
import { SECTOR_FIXTURE_NAMES, readSectorFixture } from './support/sectorFixture.ts'
import type { SectorFixtureName } from './support/sectorFixture.ts'

/**
 * Semantic goldens for the committed `.somnio-sector` fixtures: each sector's values, full
 * collection counts, and portal routing, so a dropped array, a wrong or hand-edited file, or a
 * regressed codec cannot slip through. The byte-exact round trip lives in `sector-file.test.ts`.
 */

function load(name: SectorFixtureName) {
  return readSectorFile(readSectorFixture(name), name)
}

function portal(
  x: number,
  y: number,
  width: number,
  height: number,
  targetSectorName: string,
  direction: SectorPortal['direction']
): SectorPortal {
  return { x, y, width, height, targetSectorName, direction }
}

describe('fixture encoding', () => {
  it.each(SECTOR_FIXTURE_NAMES)('%s keeps defaulted rotation and floorPatches keys omitted', (name) => {
    // The writer's whole purpose is byte stability: a semantic round-trip still passes if it
    // regresses to emitting `"rotation" : 0` or `"floorPatches" : []`, so pin the key absence.
    const sector = load(name)
    const written = writeSectorFile(sector)
    const rotationKeys = written.split('"rotation"').length - 1
    expect(rotationKeys).toBe(sector.objects.filter((object) => object.rotation !== 0).length)
    expect(written.includes('"floorPatches"')).toBe(sector.floorPatches.length > 0)
  })
})

describe('EdariaMitte', () => {
  const sector = load('EdariaMitte')

  it('is the grass square with cobbled streets', () => {
    expect(sector.version).toBe(10)
    expect(sector.dimensions).toEqual({ width: 16, height: 16 })
    expect(sector.floorMaterialID).toBe('grass-meadow')
    expect(sector.floorPatches).toEqual([
      { floorMaterialID: 'cobble-town', x: 800, y: 0, width: 448, height: 2048 },
      { floorMaterialID: 'cobble-town', x: 0, y: 800, width: 800, height: 448 },
      { floorMaterialID: 'cobble-town', x: 1248, y: 800, width: 800, height: 448 },
    ])
    expect(sector.light).toEqual({ indoor: false, brightness: 100 })
  })

  it('carries the walled square', () => {
    expect(sector.objects).toHaveLength(92)
    expect(sector.collisionMasks).toHaveLength(108)
    expect(sector.collisionMasks.filter((mask) => Math.min(mask.width, mask.height) > 56)).toHaveLength(5)
    for (const wall of sector.objects.filter((object) => object.modelID === 'stone-wall')) {
      expect(sector.collisionMasks).toContainEqual({
        x: wall.x,
        y: wall.y,
        width: wall.sourceWidth,
        height: wall.sourceHeight,
      })
    }
    expect(sector.objects.filter((object) => object.modelID === 'stone-wall')).toHaveLength(64)
    expect(
      sector.objects.filter((object) => object.modelID === 'stone-wall' && object.rotation === 90)
    ).toHaveLength(32)
    expect(sector.objects.filter((object) => object.modelID === 'stone-wall-corner')).toHaveLength(16)
    expect(sector.objects.filter((object) => object.modelID.startsWith('building-'))).toHaveLength(5)
    expect(
      sector.objects.some((object) => object.modelID === 'building-house' && object.rotation === 270)
    ).toBe(true)
    expect(
      sector.objects.some((object) => object.modelID === 'building-house' && object.rotation === 0)
    ).toBe(true)
    expect(sector.objects.some((object) => object.modelID === 'well')).toBe(true)
    expect(sector.objects.filter((object) => object.modelID === 'pine-tree')).toHaveLength(6)
    expect(sector.monsterSpawns).toEqual([])
  })

  it('places Pugnax and routes every portal', () => {
    expect(sector.npcs).toHaveLength(1)
    const meister = sector.npcs[0]!
    expect(meister.name).toBe('Pugnax')
    expect(meister.figure).toBe(18)
    expect(meister.facing).toBe(headingFromCardinal('south'))
    expect(meister.dialogScript).toContain('$name')
    expect(sector.portals).toEqual([
      portal(800, 0, 448, 16, 'Nordwiese', 'outboundTrigger'),
      portal(944, 160, 160, 96, 'Nordwiese', 'arrivalPlacement'),
      portal(1808, 420, 64, 24, 'EdariaBibliothek', 'outboundTrigger'),
      portal(1760, 464, 160, 96, 'EdariaBibliothek', 'arrivalPlacement'),
      portal(1536, 1882, 24, 64, 'EdariaArena', 'outboundTrigger'),
      portal(1568, 1862, 160, 96, 'EdariaArena', 'arrivalPlacement'),
      portal(1350, 292, 64, 24, 'EdariaShop', 'outboundTrigger'),
      portal(1302, 332, 160, 96, 'EdariaShop', 'arrivalPlacement'),
      portal(352, 140, 24, 64, 'EdariaInn', 'outboundTrigger'),
      portal(384, 156, 160, 96, 'EdariaInn', 'arrivalPlacement'),
    ])
  })
})

describe('Nordwiese', () => {
  it('is the meadow with the town wall along its south border', () => {
    const sector = load('Nordwiese')
    expect(sector.version).toBe(1)
    expect(sector.dimensions).toEqual({ width: 12, height: 12 })
    expect(sector.floorMaterialID).toBe('grass-meadow')
    expect(sector.light).toEqual({ indoor: false, brightness: 100 })
    expect(sector.objects).toHaveLength(14)
    expect(sector.collisionMasks).toHaveLength(14)
    expect(sector.objects.filter((object) => object.modelID === 'stone-wall')).toHaveLength(8)
    expect(sector.floorPatches).toEqual([
      { floorMaterialID: 'cobble-town', x: 512, y: 1408, width: 512, height: 128 },
    ])
    expect(sector.npcs).toEqual([])
    expect(sector.monsterSpawns).toEqual([])
    expect(sector.portals).toEqual([
      portal(512, 1520, 512, 16, 'EdariaMitte', 'outboundTrigger'),
      portal(688, 1360, 160, 96, 'EdariaMitte', 'arrivalPlacement'),
      portal(640, 0, 256, 16, 'Nordwald', 'outboundTrigger'),
      portal(688, 80, 160, 96, 'Nordwald', 'arrivalPlacement'),
    ])
  })
})

describe('Nordwald', () => {
  it('is the pine forest with one ghost spawn', () => {
    const sector = load('Nordwald')
    expect(sector.version).toBe(1)
    expect(sector.dimensions).toEqual({ width: 12, height: 12 })
    expect(sector.floorMaterialID).toBe('forest-floor')
    expect(sector.light).toEqual({ indoor: false, brightness: 70 })
    expect(sector.objects).toHaveLength(32)
    expect(sector.objects.every((object) => object.modelID === 'pine-tree')).toBe(true)
    expect(sector.collisionMasks).toHaveLength(32)
    expect(sector.npcs).toEqual([])
    expect(sector.portals).toEqual([
      portal(640, 1520, 256, 16, 'Nordwiese', 'outboundTrigger'),
      portal(688, 1360, 160, 96, 'Nordwiese', 'arrivalPlacement'),
    ])
    expect(sector.monsterSpawns).toHaveLength(1)
    const gespenst = sector.monsterSpawns[0]!
    expect(gespenst.name).toBe('Gespenst')
    expect(gespenst.figure).toBe(0)
    expect(gespenst.aiScriptIndex).toBe(0)
    expect(gespenst.spawnOrigin).toEqual({ x: 448, y: 384 })
    expect(gespenst.spawnBoxSize).toEqual({ width: 640, height: 384 })
    expect(gespenst.spawnHP).toBe(100)
    expect(gespenst.spawnBalance).toBe(100)
    expect(gespenst.spawnMana).toBe(100)
  })
})

describe('EdariaShop', () => {
  it('is the compact Kramladen', () => {
    const sector = load('EdariaShop')
    expect(sector.version).toBe(1)
    expect(sector.dimensions).toEqual({ width: 2, height: 2 })
    expect(sector.floorMaterialID).toBe('wood-warm')
    expect(sector.light).toEqual({ indoor: true, brightness: 100 })
    expect(sector.objects).toHaveLength(22)
    expect(sector.collisionMasks).toHaveLength(22)
    expect(sector.objects.filter((object) => object.modelID === 'counter')).toHaveLength(3)
    expect(sector.objects.filter((object) => object.modelID === 'goods-shelf')).toHaveLength(7)
    expect(sector.objects.some((object) => object.modelID === 'crate-stack')).toBe(true)
    expect(sector.objects.some((object) => object.modelID === 'rug')).toBe(true)
    expect(sector.monsterSpawns).toEqual([])
    expect(sector.npcs).toHaveLength(1)
    const kraemer = sector.npcs[0]!
    expect(kraemer.name).toBe('Mercus')
    expect(kraemer.figure).toBe(17)
    expect(kraemer.facing).toBe(headingFromCardinal('south'))
    expect(kraemer.dialogScript).toContain('$name')
    expect(sector.portals).toEqual([
      portal(86, 238, 84, 18, 'EdariaMitte', 'outboundTrigger'),
      portal(72, 148, 112, 72, 'EdariaMitte', 'arrivalPlacement'),
    ])
  })
})

describe('EdariaInn', () => {
  it('is the compact Gaststube', () => {
    const sector = load('EdariaInn')
    expect(sector.version).toBe(1)
    expect(sector.dimensions).toEqual({ width: 2, height: 2 })
    expect(sector.floorMaterialID).toBe('wood-warm')
    expect(sector.light).toEqual({ indoor: true, brightness: 100 })
    expect(sector.objects).toHaveLength(18)
    expect(sector.collisionMasks).toHaveLength(17)
    expect(
      sector.objects.filter((object) => object.modelID === 'counter' && object.rotation === 90)
    ).toHaveLength(2)
    expect(
      sector.objects.filter((object) => object.modelID === 'bed' && object.rotation === 270)
    ).toHaveLength(2)
    expect(sector.objects.filter((object) => object.modelID === 'stool')).toHaveLength(3)
    expect(sector.objects.some((object) => object.modelID === 'keg')).toBe(true)
    expect(sector.monsterSpawns).toEqual([])
    expect(sector.npcs).toHaveLength(1)
    const wirtin = sector.npcs[0]!
    expect(wirtin.name).toBe('Quieta')
    expect(wirtin.figure).toBe(17)
    expect(wirtin.facing).toBe(headingFromCardinal('east'))
    expect(wirtin.dialogScript).toContain('$name')
    expect(sector.portals).toEqual([
      portal(238, 86, 18, 84, 'EdariaMitte', 'outboundTrigger'),
      portal(144, 96, 72, 80, 'EdariaMitte', 'arrivalPlacement'),
    ])
  })
})

describe('EdariaArena', () => {
  it('is the stone arena with one ghost spawn', () => {
    const sector = load('EdariaArena')
    expect(sector.version).toBe(7)
    expect(sector.dimensions).toEqual({ width: 4, height: 4 })
    expect(sector.floorMaterialID).toBe('stone-arena')
    expect(sector.light).toEqual({ indoor: true, brightness: 75 })
    expect(sector.objects).toHaveLength(1)
    expect(sector.collisionMasks).toHaveLength(2)
    expect(sector.npcs).toEqual([])
    expect(sector.portals).toEqual([
      portal(494, 166, 18, 180, 'EdariaMitte', 'outboundTrigger'),
      portal(384, 176, 96, 160, 'EdariaMitte', 'arrivalPlacement'),
    ])
    expect(sector.monsterSpawns).toHaveLength(1)
    const gespenst = sector.monsterSpawns[0]!
    expect(gespenst.name).toBe('Gespenst')
    expect(gespenst.spawnOrigin).toEqual({ x: 64, y: 64 })
    expect(gespenst.spawnHP).toBe(100)
    expect(gespenst.spawnBalance).toBe(100)
    expect(gespenst.spawnMana).toBe(100)
  })
})

describe('EdariaBibliothek', () => {
  it('is the starter library with Libus', () => {
    const sector = load('EdariaBibliothek')
    expect(sector.version).toBe(11)
    expect(sector.dimensions).toEqual({ width: 4, height: 4 })
    expect(sector.floorMaterialID).toBe('wood-warm')
    expect(sector.light).toEqual({ indoor: true, brightness: 100 })
    expect(sector.objects).toHaveLength(33)
    expect(sector.collisionMasks).toHaveLength(21)
    expect(sector.monsterSpawns).toEqual([])
    expect(sector.npcs).toHaveLength(1)
    const libus = sector.npcs[0]!
    expect(libus.name).toBe('Libus')
    expect(libus.facing).toBe(headingFromCardinal('west'))
    expect(libus.dialogScript).toContain('$name')
    // spawnOrigin is the authored top-left, stored verbatim; centering lives in npcPlacement.
    expect(libus.spawnOrigin).toEqual({ x: 352, y: 384 })
    expect(sector.portals).toEqual([
      portal(0, 32, 256, 288, 'EdariaBibliothek', 'arrivalPlacement'),
      portal(54, 494, 180, 18, 'EdariaMitte', 'outboundTrigger'),
      portal(64, 384, 160, 96, 'EdariaMitte', 'arrivalPlacement'),
    ])
    // Representative raw geometry on the richest fixture: a count-preserving coordinate change
    // would pass the count assertions but fail these.
    expect(sector.collisionMasks[0]).toEqual({ x: 0, y: 0, width: 256, height: 22 })
    expect(sector.objects[0]).toEqual({
      x: 0,
      y: -48,
      modelID: 'bookshelf-ornate',
      sourceWidth: 64,
      sourceHeight: 96,
      priority: 0,
      rotation: 0,
    })
  })
})
