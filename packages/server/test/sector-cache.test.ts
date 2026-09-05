import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SECTOR_FIXTURE_NAMES } from '../../core/test/support/sectorFixture.ts'
import { DEV_SECTORS_DIRECTORY } from '../src/config.ts'
import { SectorCacheError, loadSectorCache, requireSectorsLoaded } from '../src/sectors/sectorCache.ts'

const CORRUPT_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/corrupt')

function errorKind(run: () => unknown): { kind: string; path: string } | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    if (error instanceof SectorCacheError) return { kind: error.kind, path: error.path }
    throw error
  }
}

describe('loadSectorCache', () => {
  it('reads every shipped sector and keys by bare filename', () => {
    const sectors = loadSectorCache(DEV_SECTORS_DIRECTORY)
    expect([...sectors.keys()]).toEqual([...SECTOR_FIXTURE_NAMES])
    const bibliothek = sectors.get('EdariaBibliothek')
    expect(bibliothek?.name).toBe('EdariaBibliothek')
    expect(bibliothek?.light.indoor).toBe(true)
  })

  it('returns one entry per loaded sector', () => {
    const sectors = loadSectorCache(DEV_SECTORS_DIRECTORY)
    expect(sectors.size).toBe(7)
    expect(sectors.get('EdariaArena')?.monsterSpawns.length).toBe(1)
  })

  it('unknown sector lookup returns undefined', () => {
    expect(loadSectorCache(DEV_SECTORS_DIRECTORY).get('DoesNotExist')).toBeUndefined()
  })

  it('parse failure surfaces SectorCacheError parseFailed with the file path', () => {
    const failure = errorKind(() => loadSectorCache(CORRUPT_DIRECTORY))
    expect(failure?.kind).toBe('parseFailed')
    expect(failure?.path.endsWith('Truncated.somnio-sector')).toBe(true)
  })

  it('unreadable directory surfaces SectorCacheError unreadable', () => {
    const bogus = `/var/empty/does-not-exist-${crypto.randomUUID()}`
    expect(errorKind(() => loadSectorCache(bogus))).toEqual({ kind: 'unreadable', path: bogus })
  })

  it('a directory without somnio-sector files loads an empty map', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sector-cache-'))
    try {
      // A stale extension-less file must be skipped, not loaded.
      writeFileSync(join(directory, 'EdariaMitte'), Buffer.from([0]))
      expect(loadSectorCache(directory).size).toBe(0)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('requireSectorsLoaded throws on empty and returns on non-empty', () => {
    expect(errorKind(() => requireSectorsLoaded(new Map(), '/x'))?.kind).toBe('noSectorsLoaded')
    expect(() => requireSectorsLoaded(loadSectorCache(DEV_SECTORS_DIRECTORY), '/x')).not.toThrow()
  })
})
