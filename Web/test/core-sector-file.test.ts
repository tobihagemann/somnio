import { describe, expect, it } from 'vitest'
import { SOMNIO_CONSTANTS } from '@/core/constants'
import { formatSwiftFloat32 } from '@/core/float'
import { SectorFileError, readSectorFile, writeSectorFile } from '@/core/sectorFile'
import type { Sector } from '@/core/sector'
import { readSectorEncodingGolden, readSectorFixture } from './helpers/sectorFixture'

/**
 * The `.somnio-sector` codec against the committed Swift fixtures — a **raw** comparison, not
 * canonicalized JSON: `MapCodec` encodes with `.sortedKeys` (unlike the wire encoder, contrast
 * `golden-frames.test.ts`), so for this format byte identity is exactly right. A failure here
 * means an authored save would rewrite unrelated bytes of every sector the server loads.
 */

const FIXTURE_NAMES = [
  'EdariaArena',
  'EdariaBibliothek',
  'EdariaInn',
  'EdariaMitte',
  'EdariaShop',
  'Nordwald',
  'Nordwiese',
] as const

function minimalSector(overrides: Partial<Sector> = {}): Sector {
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

describe('maxSectorFileBytes mirror', () => {
  it('matches the Swift declaration', () => {
    // Hand-written expectation for `Sources/SomnioCore/Constants.swift`'s
    // `maxSectorFileBytes = 16 * 1_048_576`: the Swift source spells it as an expression, which
    // `swiftStaticLet`'s bare-literal capture would misread as `16`.
    expect(SOMNIO_CONSTANTS.maxSectorFileBytes).toBe(16_777_216)
  })
})

describe('formatSwiftFloat32', () => {
  /** All verified against a live Foundation `JSONEncoder` encoding the same `Float`s. */
  it.each([
    [270, '270'],
    [123.456, '123.456'],
    [0.1, '0.1'],
    [23.198593, '23.198593'],
    [1 / 3, '0.33333334'],
    // The sub-1e-4 band a Facing entry can reach, where Foundation uses scientific notation with
    // a two-digit exponent while `String()` would not. All verified against a live Foundation
    // `JSONEncoder` encoding the same `Float`s.
    [0.0001, '0.0001'],
    [0.00001, '1e-05'],
    [0.000001, '1e-06'],
    [0.0000001, '1e-07'],
    [0.0000305, '3.05e-05'],
    [0.000099999, '9.9999e-05'],
    // Midpoint ties: Foundation rounds to even where `toPrecision` would round half-up.
    [334.515625, '334.51562'],
    [331.328125, '331.32812'],
    [264.265625, '264.26562'],
    [200.640625, '200.64062'],
  ])('formats %s as Foundation writes it', (value, expected) => {
    expect(formatSwiftFloat32(value)).toBe(expected)
  })
})

describe('fixture byte stability', () => {
  it.each(FIXTURE_NAMES)('%s round-trips byte-identical', (name) => {
    const text = readSectorFixture(name)
    const sector = readSectorFile(text, name)
    expect(sector.name).toBe(name)
    expect(writeSectorFile(sector)).toBe(text)
  })

  /**
   * The Swift-emitted synthetic golden is what actually covers the empty-array form, the
   * omitted zero `rotation`, the omitted empty `floorPatches`, JSON escaping, and the
   * non-cardinal `direction` — asserted against the committed Swift bytes, so the two writers
   * are compared to each other rather than each to itself.
   */
  it('the synthetic encoding golden round-trips byte-identical', () => {
    const text = readSectorEncodingGolden()
    const sector = readSectorFile(text, 'sector-encoding-golden')
    expect(writeSectorFile(sector)).toBe(text)

    // The cases the seven fixtures never reach, pinned semantically too.
    expect(text).toContain('"monsterSpawns" : [\n\n  ]')
    expect(text).not.toContain('"rotation" : 0')
    expect(text).not.toContain('"floorPatches"')
    expect(text).toContain('"direction" : 23.198593')
    expect(text).toContain('\\"Müller\\"')
    expect(sector.npcs[0]?.facing).toBeCloseTo(23.198593, 5)
    expect(sector.objects[0]?.rotation).toBe(0)
    expect(sector.floorPatches).toEqual([])
  })

  it('preserves a negative-zero direction as `-0`, matching Foundation', () => {
    // Swift's `Heading` keeps `-0.0` and `JSONEncoder` writes it as `-0`; `String(-0)` is `"0"`,
    // so without the serializer's special case a `-0` direction would be rewritten to `0`.
    const golden = readSectorFile(readSectorEncodingGolden(), 'sector-encoding-golden')
    const npc = golden.npcs[0]
    expect(npc).toBeDefined()
    const withNegativeZero: Sector = { ...golden, npcs: [{ ...npc!, facing: -0 }] }
    expect(writeSectorFile(withNegativeZero)).toContain('"direction" : -0')
  })
})

describe('reader validation', () => {
  it('rejects invalid JSON', () => {
    expect(() => readSectorFile('not json', 'X')).toThrow(SectorFileError)
  })

  it('rejects a missing required field', () => {
    const text = readSectorFixture('EdariaArena').replace('"version" : 7', '"versionX" : 7')
    expect(() => readSectorFile(text, 'EdariaArena')).toThrow(/version/)
  })

  it('rejects a non-integer coordinate', () => {
    const text = readSectorFixture('EdariaArena').replace('"x" : 482', '"x" : 482.5')
    expect(() => readSectorFile(text, 'EdariaArena')).toThrow(/Int16/)
  })

  it('rejects a coordinate outside Int16', () => {
    const text = readSectorFixture('EdariaArena').replace('"x" : 482', '"x" : 40000')
    expect(() => readSectorFile(text, 'EdariaArena')).toThrow(/Int16/)
  })

  it('rejects an unknown portal direction', () => {
    const text = readSectorFixture('EdariaArena').replace('"direction" : 1', '"direction" : 2')
    expect(() => readSectorFile(text, 'EdariaArena')).toThrow(/portal direction/)
  })

  it('rejects out-of-range dimensions', () => {
    const text = readSectorFixture('EdariaArena').replace(
      '"height" : 4,\n    "width" : 4',
      '"height" : 1024,\n    "width" : 1024'
    )
    expect(() => readSectorFile(text, 'EdariaArena')).toThrow(/dimensions/)
  })

  it('rejects an oversized file before parsing', () => {
    expect(() => readSectorFile(' '.repeat(SOMNIO_CONSTANTS.maxSectorFileBytes + 1), 'X')).toThrow(
      /file size/
    )
  })

  it('defaults a missing rotation to 0 and normalizes an out-of-range direction', () => {
    const text = readSectorEncodingGolden().replace('"direction" : 23.198593', '"direction" : -90')
    const sector = readSectorFile(text, 'X')
    expect(sector.objects[0]?.rotation).toBe(0)
    expect(sector.npcs[0]?.facing).toBe(270)
  })
})

describe('writer guards', () => {
  it('rejects out-of-range dimensions', () => {
    expect(() => writeSectorFile(minimalSector({ dimensions: { width: 0, height: 4 } }))).toThrow(
      /dimensions/
    )
    expect(() => writeSectorFile(minimalSector({ dimensions: { width: 1024, height: 1024 } }))).toThrow(
      /dimensions/
    )
  })

  it('rejects over-cap content counts', () => {
    const masks = Array.from({ length: SOMNIO_CONSTANTS.maxSectorCollisionMasks + 1 }, () => ({
      x: 0,
      y: 0,
      width: 32,
      height: 32,
    }))
    expect(() => writeSectorFile(minimalSector({ collisionMasks: masks }))).toThrow(/content counts/)
  })

  it('rejects a non-integer and an out-of-Int16 field', () => {
    expect(() =>
      writeSectorFile(minimalSector({ collisionMasks: [{ x: 1.5, y: 0, width: 32, height: 32 }] }))
    ).toThrow(/Int16/)
    expect(() =>
      writeSectorFile(minimalSector({ collisionMasks: [{ x: 40_000, y: 0, width: 32, height: 32 }] }))
    ).toThrow(/Int16/)
  })

  it('rejects a serialized file over the byte cap', () => {
    const sector = minimalSector({
      npcs: [
        {
          spawnOrigin: { x: 0, y: 0 },
          spawnBoxSize: { width: 32, height: 32 },
          maskSize: { width: 32, height: 48 },
          name: 'X',
          figure: 0,
          facing: 0,
          behaviorTag: 0,
          dialogScript: 'a'.repeat(SOMNIO_CONSTANTS.maxSectorFileBytes),
        },
      ],
    })
    expect(() => writeSectorFile(sector)).toThrow(/file size/)
  })

  it('measures the byte cap in UTF-8 bytes, not UTF-16 code units', () => {
    // An umlaut is one code unit but two UTF-8 bytes, so a `.length` check would pass this.
    const halfCap = Math.trunc(SOMNIO_CONSTANTS.maxSectorFileBytes / 2)
    const sector = minimalSector({
      npcs: [
        {
          spawnOrigin: { x: 0, y: 0 },
          spawnBoxSize: { width: 32, height: 32 },
          maskSize: { width: 32, height: 48 },
          name: 'X',
          figure: 0,
          facing: 0,
          behaviorTag: 0,
          dialogScript: 'ü'.repeat(halfCap + 512),
        },
      ],
    })
    expect(() => writeSectorFile(sector)).toThrow(/file size/)
  })
})
