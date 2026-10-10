import { readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { Door } from '@somnio/protocol';
import { TRIALS, WorldError, buildWorld, parseModelRegistry, readSectorFile, resolveDoor, sectorPointInSpace } from '@somnio/core';
import type { Character, ModelRegistry, ResolvedDoor, Sector, SectorSpawn, World } from '@somnio/core';
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

/** The sector whose spawn a dreamer who gave up wakes at. */
const WAKE_SECTOR = 'EdariaInn';

/**
 * What the rules name that the loaded sectors lack. The world loads all the same: without the
 * inn's spawn a dreamer who gives up wakes at the starter spawn, and a trial that names a sector
 * not loaded cannot be passed.
 */
export function ruleSectorIssues(sectors: ReadonlyMap<string, Sector>): string[] {
  const issues: string[] = [];
  if (sectors.get(WAKE_SECTOR)?.spawn === undefined) issues.push(`sector ${WAKE_SECTOR} has no spawn to wake at`);
  for (const [role, trial] of Object.entries(TRIALS)) {
    if (trial.kind === 'reach' && !sectors.has(trial.sector)) issues.push(`the ${role} trial names sector ${trial.sector}, which is not loaded`);
  }
  return issues;
}

/**
 * The world the server runs: its spaces, the registry their collision and doors resolve through,
 * where a character with nowhere to stand is put, and where a dreamer who gave up wakes.
 */
export interface LoadedWorld extends World {
  registry: ModelRegistry;
  starterSpawn: Pick<Character, 'space' | 'position' | 'facing'>;
  wakeSpawn: LoadedWorld['starterSpawn'];
}

/**
 * Builds the world from the loaded sectors. Throws on a registry that does not parse (falling
 * back to an empty one would serve a world with no collision and every door inert), on a world
 * `buildWorld` refuses, and on a starter sector without a spawn. A world without the inn, or with
 * an inn that has no spawn, wakes its dreamers at the starter spawn.
 */
export function loadWorld(sectors: ReadonlyMap<string, Sector>, rawRegistry: unknown): LoadedWorld {
  const registry = parseModelRegistry(rawRegistry);
  const world = buildWorld([...sectors.values()], registry);
  const starter = sectors.get(STARTER_SECTOR);
  if (starter?.spawn === undefined) throw new WorldError(`starter sector ${STARTER_SECTOR} has no spawn`);
  const spawnIn = (sector: Sector, spawn: SectorSpawn): LoadedWorld['starterSpawn'] => ({
    space: world.sectorSpace.get(sector.name)!,
    position: sectorPointInSpace(sector, spawn),
    facing: spawn.facing,
  });
  const starterSpawn = spawnIn(starter, starter.spawn);
  const inn = sectors.get(WAKE_SECTOR);
  return { ...world, registry, starterSpawn, wakeSpawn: inn?.spawn === undefined ? starterSpawn : spawnIn(inn, inn.spawn) };
}

/** A live door of one of the space's sectors, resolved into the space. */
export function doorIn(world: LoadedWorld, spaceId: string, sectorName: string, doorId: string): { door: Door; resolved: ResolvedDoor } | undefined {
  const sector = world.spaces.get(spaceId)?.sectors.find((candidate) => candidate.name === sectorName);
  const door = sector?.doors.find((candidate) => candidate.id === doorId);
  if (sector === undefined || door === undefined) return undefined;
  const resolved = resolveDoor(sector, door, world.registry);
  return resolved === undefined ? undefined : { door, resolved };
}

/** The door a live door leads to, and its space. The world keeps a door only as half of a sound pair, so both resolve. */
export function counterpartOf(world: LoadedWorld, door: Door): { spaceId: string; resolved: ResolvedDoor } {
  const spaceId = world.sectorSpace.get(door.target.sector)!;
  return { spaceId, resolved: doorIn(world, spaceId, door.target.sector, door.target.door)!.resolved };
}
