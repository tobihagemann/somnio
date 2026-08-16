import type { Sector } from '@/core/sector'
import { readSectorFile, writeSectorFile } from '@/core/sectorFile'
import { DEFAULT_SECTOR_VERSION } from './preferences'
import { SECTOR_API_PREFIX } from './sectorName'

/**
 * The document model: one `Sector` and a single `mutate` funnel that snapshots the whole body
 * before applying, so undo/redo are symmetric across N steps. Three deliberate decisions:
 *
 * - **The name lives in exactly one place** — `Sector.name`. It participates in snapshots
 *   and the saved checkpoint, so Sector Settings renames are undoable and dirty-tracked;
 *   there is no separate name field to diverge.
 * - **Snapshots are deep clones** (`structuredClone`): a reference snapshot would be mutated
 *   in place by the next inspector edit, so undo would restore nothing.
 * - **Dirty derives from a saved checkpoint, not a flag**: a boolean set on mutation cannot
 *   represent save → mutate → undo-back-to-savepoint, which must read as clean again.
 *
 * File I/O goes through the dev-server sector API (`/__editor/sectors`). Save As writes the
 * new file and leaves the original in place; there is no delete, matching the absent
 * `DELETE` route.
 */

interface UndoEntry {
  actionName: string
  sector: Sector
}

export function uninitializedSector(): Sector {
  return {
    name: '',
    version: DEFAULT_SECTOR_VERSION,
    dimensions: { width: 0, height: 0 },
    floorMaterialID: '',
    light: { indoor: false, brightness: 0 },
    objects: [],
    collisionMasks: [],
    portals: [],
    npcs: [],
    monsterSpawns: [],
    floorPatches: [],
  }
}

export async function listSectors(): Promise<string[]> {
  const response = await fetch(SECTOR_API_PREFIX)
  if (!response.ok) throw new Error(`listing sectors failed: ${response.status}`)
  return (await response.json()) as string[]
}

export class EditorDocument {
  sector: Sector = uninitializedSector()

  private undoStack: UndoEntry[] = []
  private redoStack: UndoEntry[] = []
  private savedSnapshot: Sector | undefined
  /** Notifies the shell after every document change — mutate, undo, redo, load, save. */
  onChanged: (() => void) | undefined

  /** The fresh-document sentinel: true until a sector is created or loaded, gating auto-present. */
  get isUninitialized(): boolean {
    return (
      this.sector.name === '' && this.sector.dimensions.width === 0 && this.sector.dimensions.height === 0
    )
  }

  get isDirty(): boolean {
    if (this.isUninitialized) return false
    if (this.savedSnapshot === undefined) return true
    return !deepEqual(this.sector, this.savedSnapshot)
  }

  get undoDepth(): number {
    return this.undoStack.length
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  /** The single mutation API. Every new edit clears the redo stack. */
  mutate(actionName: string, change: (sector: Sector) => void): void {
    const before = structuredClone(this.sector)
    change(this.sector)
    this.undoStack.push({ actionName, sector: before })
    this.redoStack = []
    this.onChanged?.()
  }

  undo(): void {
    const entry = this.undoStack.pop()
    if (entry === undefined) return
    this.redoStack.push({ actionName: entry.actionName, sector: structuredClone(this.sector) })
    this.sector = entry.sector
    this.onChanged?.()
  }

  redo(): void {
    const entry = this.redoStack.pop()
    if (entry === undefined) return
    this.undoStack.push({ actionName: entry.actionName, sector: structuredClone(this.sector) })
    this.sector = entry.sector
    this.onChanged?.()
  }

  /** Replaces the document with a freshly loaded sector; `load` preserves the file's version. */
  async load(name: string): Promise<void> {
    const response = await fetch(`${SECTOR_API_PREFIX}/${encodeURIComponent(name)}`)
    if (!response.ok) throw new Error(`loading "${name}" failed: ${response.status}`)
    this.sector = readSectorFile(await response.text(), name)
    this.undoStack = []
    this.redoStack = []
    this.savedSnapshot = structuredClone(this.sector)
    this.onChanged?.()
  }

  /** `⌘S`. The checkpoint updates only after a successful write. */
  async save(): Promise<void> {
    // Snapshot before the await and checkpoint that exact snapshot on success: editing stays
    // enabled during the PUT, so checkpointing `this.sector` afterward would mark a mid-flight
    // edit clean even though only the older body reached disk.
    const snapshot = structuredClone(this.sector)
    const text = writeSectorFile(snapshot)
    const response = await fetch(`${SECTOR_API_PREFIX}/${encodeURIComponent(snapshot.name)}`, {
      method: 'PUT',
      body: text,
    })
    if (!response.ok) throw new Error(`saving "${snapshot.name}" failed: ${response.status}`)
    this.savedSnapshot = snapshot
    this.onChanged?.()
  }

  /**
   * `⇧⌘S`. Takes the new name directly (not through `mutate` — NSDocument's Save As never
   * put the rename on the undo stack either) and writes the new file, leaving the original.
   */
  async saveAs(name: string): Promise<void> {
    const previous = this.sector.name
    this.sector.name = name
    try {
      await this.save()
    } catch (error) {
      // A failed write must leave the document untouched — the rename bypasses `mutate`, so
      // there is no undo entry to walk back; restore the name by hand before rethrowing.
      this.sector.name = previous
      throw error
    }
  }

  /** New Map: replaces the document in place as one undoable step, stamping version 1. */
  create(form: {
    name: string
    width: number
    height: number
    indoor: boolean
    brightness: number
    floorMaterialID: string
  }): void {
    this.mutate('Create new map', (sector) => {
      sector.name = form.name
      sector.version = DEFAULT_SECTOR_VERSION
      sector.dimensions = { width: form.width, height: form.height }
      sector.floorMaterialID = form.floorMaterialID
      sector.light = { indoor: form.indoor, brightness: form.brightness }
      sector.objects = []
      sector.collisionMasks = []
      sector.portals = []
      sector.npcs = []
      sector.monsterSpawns = []
      sector.floorPatches = []
    })
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]))
  }
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const aRecord = a as Record<string, unknown>
    const bRecord = b as Record<string, unknown>
    const aKeys = Object.keys(aRecord)
    const bKeys = Object.keys(bRecord)
    return aKeys.length === bKeys.length && aKeys.every((key) => deepEqual(aRecord[key], bRecord[key]))
  }
  return false
}
