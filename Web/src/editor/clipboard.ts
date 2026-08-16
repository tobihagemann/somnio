import { clampToInt16 } from '@/core/geometry'
import type { GridPoint } from '@/core/geometry'
import type {
  CollisionMask,
  FloorPatch,
  MonsterSpawn,
  Sector,
  SectorNPC,
  SectorObject,
  SectorPortal,
} from '@/core/sector'
import { writeSectorFile } from '@/core/sectorFile'
import type { EditorSelection } from './selection'
import { isValidSelection } from './selection'

/**
 * An in-page record buffer over the six record kinds, rather than the system clipboard:
 * cross-page paste is not needed, and a custom pasteboard type has no clean browser equivalent.
 */

export interface EditorClipboard {
  objects: SectorObject[]
  collisionMasks: CollisionMask[]
  portals: SectorPortal[]
  npcs: SectorNPC[]
  monsterSpawns: MonsterSpawn[]
  floorPatches: FloorPatch[]
}

export function emptyClipboard(): EditorClipboard {
  return { objects: [], collisionMasks: [], portals: [], npcs: [], monsterSpawns: [], floorPatches: [] }
}

export function isClipboardEmpty(clipboard: EditorClipboard): boolean {
  return (
    clipboard.objects.length === 0 &&
    clipboard.collisionMasks.length === 0 &&
    clipboard.portals.length === 0 &&
    clipboard.npcs.length === 0 &&
    clipboard.monsterSpawns.length === 0 &&
    clipboard.floorPatches.length === 0
  )
}

/**
 * Snapshots every selected record's value (stale indices skipped) in ascending source-array
 * order — insertion appends each array verbatim and picking treats later records as topmost,
 * so a set-ordered capture would shuffle overlapping records' stacking on paste.
 */
export function captureClipboard(selections: readonly EditorSelection[], sector: Sector): EditorClipboard {
  const clipboard = emptyClipboard()
  const ordered = [...selections].sort((a, b) => a.index - b.index)
  for (const selection of ordered) {
    if (!isValidSelection(selection, sector)) continue
    switch (selection.kind) {
      case 'object':
        clipboard.objects.push(structuredClone(sector.objects[selection.index]!))
        break
      case 'mask':
        clipboard.collisionMasks.push(structuredClone(sector.collisionMasks[selection.index]!))
        break
      case 'portal':
        clipboard.portals.push(structuredClone(sector.portals[selection.index]!))
        break
      case 'npc':
        clipboard.npcs.push(structuredClone(sector.npcs[selection.index]!))
        break
      case 'monsterSpawn':
        clipboard.monsterSpawns.push(structuredClone(sector.monsterSpawns[selection.index]!))
        break
      case 'floorPatch':
        clipboard.floorPatches.push(structuredClone(sector.floorPatches[selection.index]!))
        break
    }
  }
  return clipboard
}

/**
 * Appends clones of every carried record, shifted as a group: with an `anchor` the payload's
 * top-left bounding corner lands there (paste-at-cursor); without one every origin shifts by
 * `fallbackOffset` on both axes (duplicate). Returns the clones' selections.
 */
export function insertClipboard(
  clipboard: EditorClipboard,
  sector: Sector,
  anchor: GridPoint | undefined,
  fallbackOffset: number
): EditorSelection[] {
  if (isClipboardEmpty(clipboard)) return []
  const minOrigin = boundingOrigin(clipboard)
  const shift =
    anchor !== undefined && minOrigin !== undefined
      ? { dx: anchor.x - minOrigin.x, dy: anchor.y - minOrigin.y }
      : { dx: fallbackOffset, dy: fallbackOffset }
  const inserted: EditorSelection[] = []
  for (const object of clipboard.objects) {
    const clone = structuredClone(object)
    clone.x = clampToInt16(clone.x + shift.dx)
    clone.y = clampToInt16(clone.y + shift.dy)
    sector.objects.push(clone)
    inserted.push({ kind: 'object', index: sector.objects.length - 1 })
  }
  for (const mask of clipboard.collisionMasks) {
    const clone = structuredClone(mask)
    clone.x = clampToInt16(clone.x + shift.dx)
    clone.y = clampToInt16(clone.y + shift.dy)
    sector.collisionMasks.push(clone)
    inserted.push({ kind: 'mask', index: sector.collisionMasks.length - 1 })
  }
  for (const portal of clipboard.portals) {
    const clone = structuredClone(portal)
    clone.x = clampToInt16(clone.x + shift.dx)
    clone.y = clampToInt16(clone.y + shift.dy)
    sector.portals.push(clone)
    inserted.push({ kind: 'portal', index: sector.portals.length - 1 })
  }
  for (const npc of clipboard.npcs) {
    const clone = structuredClone(npc)
    clone.spawnOrigin = shifted(clone.spawnOrigin, shift)
    sector.npcs.push(clone)
    inserted.push({ kind: 'npc', index: sector.npcs.length - 1 })
  }
  for (const spawn of clipboard.monsterSpawns) {
    const clone = structuredClone(spawn)
    clone.spawnOrigin = shifted(clone.spawnOrigin, shift)
    sector.monsterSpawns.push(clone)
    inserted.push({ kind: 'monsterSpawn', index: sector.monsterSpawns.length - 1 })
  }
  for (const patch of clipboard.floorPatches) {
    const clone = structuredClone(patch)
    clone.x = clampToInt16(clone.x + shift.dx)
    clone.y = clampToInt16(clone.y + shift.dy)
    sector.floorPatches.push(clone)
    inserted.push({ kind: 'floorPatch', index: sector.floorPatches.length - 1 })
  }
  return inserted
}

/**
 * The full paste/duplicate gate as one pure step: inserts at the anchor and accepts only a
 * body the writer round-trips — its content counts and encoded-size caps included — so a
 * paste can never wedge the document into a state its own writer refuses to save.
 */
export function validatedPaste(
  clipboard: EditorClipboard,
  sector: Sector,
  anchor: GridPoint | undefined,
  fallbackOffset: number
): { sector: Sector; selection: EditorSelection[] } | undefined {
  if (isClipboardEmpty(clipboard)) return undefined
  const candidate = structuredClone(sector)
  const inserted = insertClipboard(clipboard, candidate, anchor, fallbackOffset)
  try {
    writeSectorFile(candidate)
  } catch {
    return undefined
  }
  return { sector: candidate, selection: inserted }
}

/** Top-left corner of the payload's bounding box, or `undefined` for an empty payload. */
export function boundingOrigin(clipboard: EditorClipboard): { x: number; y: number } | undefined {
  let minX: number | undefined
  let minY: number | undefined
  const fold = (x: number, y: number): void => {
    minX = minX === undefined ? x : Math.min(minX, x)
    minY = minY === undefined ? y : Math.min(minY, y)
  }
  for (const object of clipboard.objects) fold(object.x, object.y)
  for (const mask of clipboard.collisionMasks) fold(mask.x, mask.y)
  for (const portal of clipboard.portals) fold(portal.x, portal.y)
  for (const npc of clipboard.npcs) fold(npc.spawnOrigin.x, npc.spawnOrigin.y)
  for (const spawn of clipboard.monsterSpawns) fold(spawn.spawnOrigin.x, spawn.spawnOrigin.y)
  for (const patch of clipboard.floorPatches) fold(patch.x, patch.y)
  if (minX === undefined || minY === undefined) return undefined
  return { x: minX, y: minY }
}

function shifted(point: GridPoint, shift: { dx: number; dy: number }): GridPoint {
  return { x: clampToInt16(point.x + shift.dx), y: clampToInt16(point.y + shift.dy) }
}
