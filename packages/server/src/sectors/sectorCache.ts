import { readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { WorldError, buildWorld, parseModelRegistry, readSectorFile, sectorPointInSpace } from '@somnio/core';
import type { Character, ModelRegistry, Sector, World } from '@somnio/core';
import { STARTER_SECTOR } from '@somnio/data';

export type SectorCacheErrorKind = 'unreadable' | 'parseFailed' | 'noSectorsLoaded';

export class SectorCacheError extends Error {
  readonly kind: SectorCacheErrorKind;
  readonly path: string;

  constructor(kind: SectorCacheErrorKind, path: string, message: string) {
    super(message);
    this.name = 'SectorCacheError';
    this.kind = kind;
    this.path = path;
  }
}

const EXTENSION = '.somnio-sector';

/**
 * Reads every `.somnio-sector` file in `directory` (sorted, other entries skipped) and keys each
 * by its extension-stripped filename — the filename-as-sector-id convention door targets rely
 * on. Throws on the first parse failure so startup fails closed.
 */
export function loadSectorCache(directory: string): Map<string, Sector> {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    throw new SectorCacheError('unreadable', directory, `sectors directory is unreadable: ${directory}`);
  }
  const sectors = new Map<string, Sector>();
  for (const entry of entries.sort()) {
    if (entry.startsWith('.') || extname(entry) !== EXTENSION) continue;
    const name = basename(entry, EXTENSION);
    const path = join(directory, entry);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      throw new SectorCacheError('unreadable', path, `sector file is unreadable: ${path}`);
    }
    try {
      sectors.set(name, readSectorFile(text, name));
    } catch (error) {
      throw new SectorCacheError('parseFailed', path, `sector ${name} failed to parse: ${String(error)}`);
    }
  }
  return sectors;
}

/** The world would otherwise boot empty and every login would fail. */
export function requireSectorsLoaded(sectors: ReadonlyMap<string, Sector>, directory: string): void {
  if (sectors.size === 0) {
    throw new SectorCacheError('noSectorsLoaded', directory, `no sectors loaded from ${directory} (expected at least one ${EXTENSION} file)`);
  }
}

/** The world the server runs: its spaces, the registry their collision and doors resolve through, and where a character with nowhere to stand is put. */
export interface LoadedWorld extends World {
  registry: ModelRegistry;
  starterSpawn: Pick<Character, 'space' | 'position' | 'facing'>;
}

/**
 * Builds the world from the loaded sectors. Throws on a registry that does not parse (falling
 * back to an empty one would serve a world with no collision and every door inert), on a world
 * `buildWorld` refuses, and on a starter sector without a spawn.
 */
export function loadWorld(sectors: ReadonlyMap<string, Sector>, rawRegistry: unknown): LoadedWorld {
  const registry = parseModelRegistry(rawRegistry);
  const world = buildWorld([...sectors.values()], registry);
  const starter = sectors.get(STARTER_SECTOR);
  if (starter?.spawn === undefined) throw new WorldError(`starter sector ${STARTER_SECTOR} has no spawn`);
  return {
    ...world,
    registry,
    starterSpawn: { space: world.sectorSpace.get(STARTER_SECTOR)!, position: sectorPointInSpace(starter, starter.spawn), facing: starter.spawn.facing },
  };
}
