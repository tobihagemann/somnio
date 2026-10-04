import { SectorFileError, readSectorFile, rectsOverlap, writeSectorFile } from '@somnio/core';
import type { Sector } from '@somnio/core';
import type { SectorKind } from '@somnio/protocol';
import { SECTOR_API_PREFIX } from './sectorName';

/**
 * The document model: one `Sector` and a single `commit` funnel that validates the next body and
 * keeps the previous one for undo, so undo/redo are symmetric across N steps. Three deliberate
 * decisions:
 *
 * - **The name lives in exactly one place** — `Sector.name`. It participates in snapshots
 *   and the saved checkpoint, so Sector Settings renames are undoable and dirty-tracked;
 *   there is no separate name field to diverge.
 * - **A commit never edits the live body**: the next body is a deep clone (`structuredClone`)
 *   that replaces it, and the body it replaces is the undo snapshot. Editing in place would
 *   change the snapshot too, so undo would restore nothing.
 * - **Dirty derives from a saved checkpoint, not a flag**: a boolean set on mutation cannot
 *   represent save → mutate → undo-back-to-savepoint, which must read as clean again.
 *
 * File I/O goes through the dev-server sector API (`/__editor/sectors`). Save As writes the
 * new file and leaves the original in place; there is no delete, matching the absent
 * `DELETE` route.
 */

interface UndoEntry {
  actionName: string;
  sector: Sector;
}

export type CommitResult = { accepted: true } | { accepted: false; message: string };

/** What the sector form edits: everything about a sector that is not a record. */
export interface SectorSettings {
  name: string;
  kind: SectorKind;
  width: number;
  depth: number;
  /** Outdoor only. */
  originX: number;
  originZ: number;
  /** Interior only. */
  brightness: number;
  floorMaterialId: string;
}

function uninitializedSector(): Sector {
  return {
    name: '',
    kind: 'outdoor',
    origin: { x: 0, z: 0 },
    size: { width: 0, depth: 0 },
    floorMaterialId: '',
    floorPatches: [],
    placements: [],
    blockers: [],
    doors: [],
    npcs: [],
    monsterSpawns: [],
  };
}

export function sectorSettings(sector: Sector): SectorSettings {
  return {
    name: sector.name,
    kind: sector.kind,
    width: sector.size.width,
    depth: sector.size.depth,
    originX: sector.origin?.x ?? 0,
    originZ: sector.origin?.z ?? 0,
    brightness: sector.brightness ?? 100,
    floorMaterialId: sector.floorMaterialId,
  };
}

/** Writes the settings into the sector. An outdoor sector carries an origin and an interior a brightness, never both. */
export function applySectorSettings(sector: Sector, settings: SectorSettings): void {
  sector.name = settings.name;
  sector.kind = settings.kind;
  sector.size = { width: settings.width, depth: settings.depth };
  sector.floorMaterialId = settings.floorMaterialId;
  delete sector.origin;
  delete sector.brightness;
  if (settings.kind === 'outdoor') sector.origin = { x: settings.originX, z: settings.originZ };
  else sector.brightness = settings.brightness;
}

export async function listSectors(): Promise<string[]> {
  const response = await fetch(SECTOR_API_PREFIX);
  if (!response.ok) throw new Error(`listing sectors failed: ${response.status}`);
  return (await response.json()) as string[];
}

export async function loadSector(name: string): Promise<Sector> {
  const response = await fetch(`${SECTOR_API_PREFIX}/${encodeURIComponent(name)}`);
  if (!response.ok) throw new Error(`loading "${name}" failed: ${response.status}`);
  return readSectorFile(await response.text(), name);
}

export class EditorDocument {
  sector: Sector = uninitializedSector();

  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private savedSnapshot: Sector | undefined;
  /** Notifies the shell after every document change — commit, undo, redo, load, save. */
  onChanged: (() => void) | undefined;

  /** The fresh-document sentinel: true until a sector is created or loaded, gating auto-present. */
  get isUninitialized(): boolean {
    return this.sector.name === '' && this.sector.size.width === 0 && this.sector.size.depth === 0;
  }

  get isDirty(): boolean {
    if (this.isUninitialized) return false;
    if (this.savedSnapshot === undefined) return true;
    return !deepEqual(this.sector, this.savedSnapshot);
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * The single mutation API: `next` replaces the document as one undo step, unless the sector
   * codec would refuse to save it or it introduces overlapping floor patches (coplanar quads
   * z-fight). A file that already carries an overlap still edits elsewhere; only a commit that
   * adds one is refused. A commit that changes nothing is accepted and is not an undo step: it
   * leaves both stacks as they are and notifies no one. Every other accepted commit clears the
   * redo stack.
   */
  commit(actionName: string, next: Sector): CommitResult {
    try {
      writeSectorFile(next);
    } catch (error) {
      if (!(error instanceof SectorFileError)) throw error;
      return { accepted: false, message: error.reason };
    }
    const before = overlappingPatchPairs(this.sector);
    if ([...overlappingPatchPairs(next)].some((pair) => !before.has(pair))) {
      return { accepted: false, message: 'Floor patches must not overlap.' };
    }
    if (deepEqual(next, this.sector)) return { accepted: true };
    this.undoStack.push({ actionName, sector: this.sector });
    this.sector = next;
    this.redoStack = [];
    this.onChanged?.();
    return { accepted: true };
  }

  /** Commits a change described as edits to a copy of the document. */
  mutate(actionName: string, change: (sector: Sector) => void): CommitResult {
    const next = structuredClone(this.sector);
    change(next);
    return this.commit(actionName, next);
  }

  undo(): void {
    const entry = this.undoStack.pop();
    if (entry === undefined) return;
    this.redoStack.push({ actionName: entry.actionName, sector: this.sector });
    this.sector = entry.sector;
    this.onChanged?.();
  }

  redo(): void {
    const entry = this.redoStack.pop();
    if (entry === undefined) return;
    this.undoStack.push({ actionName: entry.actionName, sector: this.sector });
    this.sector = entry.sector;
    this.onChanged?.();
  }

  /** Replaces the document with a freshly loaded sector. */
  async load(name: string): Promise<void> {
    this.sector = await loadSector(name);
    this.undoStack = [];
    this.redoStack = [];
    this.savedSnapshot = structuredClone(this.sector);
    this.onChanged?.();
  }

  /** `⌘S`. The checkpoint updates only after a successful write. */
  async save(): Promise<void> {
    // Snapshot before the await and checkpoint that exact snapshot on success: editing stays
    // enabled during the PUT, so checkpointing `this.sector` afterward would mark a mid-flight
    // edit clean even though only the older body reached disk.
    const snapshot = structuredClone(this.sector);
    const text = writeSectorFile(snapshot);
    const response = await fetch(`${SECTOR_API_PREFIX}/${encodeURIComponent(snapshot.name)}`, {
      method: 'PUT',
      body: text,
    });
    if (!response.ok) throw new Error(`saving "${snapshot.name}" failed: ${response.status}`);
    this.savedSnapshot = snapshot;
    this.onChanged?.();
  }

  /**
   * `⇧⌘S`. Takes the new name directly (not through `commit`, so the rename stays off the undo
   * stack) and writes the new file, leaving the original.
   */
  async saveAs(name: string): Promise<void> {
    const previous = this.sector.name;
    this.sector.name = name;
    try {
      await this.save();
    } catch (error) {
      // A failed write must leave the document untouched — the rename bypasses `commit`, so
      // there is no undo entry to walk back; restore the name by hand before rethrowing.
      this.sector.name = previous;
      throw error;
    }
  }

  /** New Map: replaces the document in place as one undoable step. */
  create(settings: SectorSettings): CommitResult {
    const sector = uninitializedSector();
    applySectorSettings(sector, settings);
    return this.commit('Create new map', sector);
  }
}

/**
 * The overlapping floor-patch pairs, each keyed by the two rects themselves, so a pair survives a
 * rename and a deletion elsewhere and only a move or resize makes it a new one. Rects that only
 * touch do not overlap.
 */
function overlappingPatchPairs(sector: Sector): Set<string> {
  const patches = sector.floorPatches;
  const pairs = new Set<string>();
  patches.forEach((first, index) => {
    for (const second of patches.slice(index + 1)) {
      if (rectsOverlap(first, second)) pairs.add(JSON.stringify([first, second].map((patch) => [patch.x, patch.z, patch.width, patch.depth])));
    }
  });
  return pairs;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    const aKeys = Object.keys(aRecord);
    const bKeys = Object.keys(bRecord);
    return aKeys.length === bKeys.length && aKeys.every((key) => deepEqual(aRecord[key], bRecord[key]));
  }
  return false;
}
