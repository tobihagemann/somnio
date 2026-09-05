import { readFileSync, readdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { readSectorFile } from '@somnio/core'
import type { Sector } from '@somnio/core'

export type SectorCacheErrorKind = 'unreadable' | 'parseFailed' | 'noSectorsLoaded'

export class SectorCacheError extends Error {
  readonly kind: SectorCacheErrorKind
  readonly path: string

  constructor(kind: SectorCacheErrorKind, path: string, message: string) {
    super(message)
    this.name = 'SectorCacheError'
    this.kind = kind
    this.path = path
  }
}

const EXTENSION = '.somnio-sector'

/**
 * Reads every `.somnio-sector` file in `directory` (sorted, other entries skipped) and keys each
 * by its extension-stripped filename — the filename-as-sector-id convention portal targets rely
 * on. Throws on the first parse failure so startup fails closed.
 */
export function loadSectorCache(directory: string): Map<string, Sector> {
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    throw new SectorCacheError('unreadable', directory, `sectors directory is unreadable: ${directory}`)
  }
  const sectors = new Map<string, Sector>()
  for (const entry of entries.sort()) {
    if (entry.startsWith('.') || extname(entry) !== EXTENSION) continue
    const name = basename(entry, EXTENSION)
    const path = join(directory, entry)
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      throw new SectorCacheError('unreadable', path, `sector file is unreadable: ${path}`)
    }
    try {
      sectors.set(name, readSectorFile(text, name))
    } catch (error) {
      throw new SectorCacheError('parseFailed', path, `sector ${name} failed to parse: ${String(error)}`)
    }
  }
  return sectors
}

/** The world would otherwise boot empty and every login would fail. */
export function requireSectorsLoaded(sectors: ReadonlyMap<string, Sector>, directory: string): void {
  if (sectors.size === 0) {
    throw new SectorCacheError(
      'noSectorsLoaded',
      directory,
      `no sectors loaded from ${directory} (expected at least one ${EXTENSION} file)`
    )
  }
}
