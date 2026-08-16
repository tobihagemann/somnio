import type { GridPoint, GridSize } from '@/core/geometry'
import type { Sector } from '@/core/sector'

/**
 * Selection state over the six record kinds. Floor patches are a first-class record (the
 * format always supported them; no tool ever exposed them). NPCs and monster spawns keep
 * distinct kinds because they live in distinct `Sector` arrays, so deletes and index clamps
 * stay unambiguous.
 *
 * Selections are value-shaped `{kind, index}` pairs; JavaScript `Set` compares by reference,
 * so the set operations live in the list helpers below, keyed by `selectionKey`.
 */

export type SelectionKind = 'object' | 'mask' | 'portal' | 'npc' | 'monsterSpawn' | 'floorPatch'

export interface EditorSelection {
  kind: SelectionKind
  index: number
}

export function selectionKey(selection: EditorSelection): string {
  return `${selection.kind}:${selection.index}`
}

export function selectionsEqual(a: readonly EditorSelection[], b: readonly EditorSelection[]): boolean {
  if (a.length !== b.length) return false
  const keys = new Set(a.map(selectionKey))
  return b.every((selection) => keys.has(selectionKey(selection)))
}

export function containsSelection(list: readonly EditorSelection[], selection: EditorSelection): boolean {
  return list.some((candidate) => selectionKey(candidate) === selectionKey(selection))
}

/** Shift-click membership toggle. */
export function toggleSelection(
  list: readonly EditorSelection[],
  selection: EditorSelection
): EditorSelection[] {
  return containsSelection(list, selection)
    ? list.filter((candidate) => selectionKey(candidate) !== selectionKey(selection))
    : [...list, selection]
}

/**
 * The selected record's bounds, or `undefined` when the index has been invalidated. Shared
 * by the canvas hit-tester, the overlay highlight, and the readout, so record kinds extend
 * this single switch.
 */
export function selectionBounds(
  selection: EditorSelection,
  sector: Sector
): { origin: GridPoint; size: GridSize } | undefined {
  switch (selection.kind) {
    case 'object': {
      const object = sector.objects[selection.index]
      if (object === undefined) return undefined
      return {
        origin: { x: object.x, y: object.y },
        size: { width: object.sourceWidth, height: object.sourceHeight },
      }
    }
    case 'mask': {
      const mask = sector.collisionMasks[selection.index]
      if (mask === undefined) return undefined
      return { origin: { x: mask.x, y: mask.y }, size: { width: mask.width, height: mask.height } }
    }
    case 'portal': {
      const portal = sector.portals[selection.index]
      if (portal === undefined) return undefined
      return { origin: { x: portal.x, y: portal.y }, size: { width: portal.width, height: portal.height } }
    }
    case 'npc': {
      const npc = sector.npcs[selection.index]
      if (npc === undefined) return undefined
      return { origin: { ...npc.spawnOrigin }, size: { ...npc.spawnBoxSize } }
    }
    case 'monsterSpawn': {
      const spawn = sector.monsterSpawns[selection.index]
      if (spawn === undefined) return undefined
      return { origin: { ...spawn.spawnOrigin }, size: { ...spawn.spawnBoxSize } }
    }
    case 'floorPatch': {
      const patch = sector.floorPatches[selection.index]
      if (patch === undefined) return undefined
      return { origin: { x: patch.x, y: patch.y }, size: { width: patch.width, height: patch.height } }
    }
  }
}

export function isValidSelection(selection: EditorSelection, sector: Sector): boolean {
  return selectionBounds(selection, sector) !== undefined
}

/**
 * Removes every selected record in one pass. Selections are partitioned by kind and each
 * kind's indices removed in **descending** order — each removal shifts the indices behind
 * it, so ascending removal would delete the wrong records.
 */
export function removeAllSelections(selections: readonly EditorSelection[], sector: Sector): void {
  const byKind = new Map<SelectionKind, number[]>()
  for (const selection of selections) {
    byKind.set(selection.kind, [...(byKind.get(selection.kind) ?? []), selection.index])
  }
  removeDescending(byKind.get('object'), sector.objects)
  removeDescending(byKind.get('mask'), sector.collisionMasks)
  removeDescending(byKind.get('portal'), sector.portals)
  removeDescending(byKind.get('npc'), sector.npcs)
  removeDescending(byKind.get('monsterSpawn'), sector.monsterSpawns)
  removeDescending(byKind.get('floorPatch'), sector.floorPatches)
}

function removeDescending(indices: number[] | undefined, records: unknown[]): void {
  if (indices === undefined) return
  for (const index of [...indices].sort((a, b) => b - a)) {
    if (index >= 0 && index < records.length) records.splice(index, 1)
  }
}
