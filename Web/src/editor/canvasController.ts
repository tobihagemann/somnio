import type * as THREE from 'three'
import { clampToInt16 } from '@/core/geometry'
import type { GridPoint } from '@/core/geometry'
import type { Sector } from '@/core/sector'
import { floorPixelAtScreen } from './picking'
import type { ScreenPoint, ViewportSize } from './picking'
import { selectionBounds } from './selection'
import type { EditorSelection } from './selection'

/**
 * Stateless canvas geometry and pick dispatch. Floor patches are a first-class tool and record.
 */

export type EditorTool = 'select' | 'object' | 'mask' | 'portal' | 'npc' | 'monster' | 'floorPatch'

export const EDITOR_TOOLS: readonly EditorTool[] = [
  'select',
  'object',
  'mask',
  'portal',
  'npc',
  'monster',
  'floorPatch',
]

/**
 * Converts a top-left viewport point to a legacy top-left grid coordinate: unproject onto the
 * floor plane, then floor each axis into Int16 (the same downward rounding the 2D pixel
 * canvas used).
 */
export function gridPoint(
  camera: THREE.OrthographicCamera,
  viewport: ViewportSize,
  screen: ScreenPoint
): GridPoint {
  const pixel = floorPixelAtScreen(camera, viewport, screen)
  return { x: clampToInt16(Math.floor(pixel.x)), y: clampToInt16(Math.floor(pixel.y)) }
}

/**
 * Legacy-axis delta an arrow-key nudge moves the selection by: 1 px, or the grid step
 * (floored to 1) with Shift held. Non-arrow keys resolve to `undefined`.
 */
export function nudgeDelta(
  key: string,
  shiftHeld: boolean,
  gridStep: number
): { dx: number; dy: number } | undefined {
  const step = shiftHeld ? Math.max(1, gridStep) : 1
  switch (key) {
    case 'ArrowUp':
      return { dx: 0, dy: -step }
    case 'ArrowDown':
      return { dx: 0, dy: step }
    case 'ArrowLeft':
      return { dx: -step, dy: 0 }
    case 'ArrowRight':
      return { dx: step, dy: 0 }
    default:
      return undefined
  }
}

/**
 * Pick candidates in preference order, back-to-front within each kind so the most-recently-
 * placed record wins overlaps. NPCs first so small spawn boxes stay reachable under the
 * larger portal/mask/object rects; floor patches last, below masks, matching their overlay
 * layer. This ordering is why a click overlapping a mask selects the mask rather than the
 * prop underneath.
 */
export function candidateSelections(sector: Sector, tool: EditorTool): EditorSelection[] {
  const reversed = (kind: EditorSelection['kind'], count: number): EditorSelection[] =>
    Array.from({ length: count }, (_, offset) => ({ kind, index: count - 1 - offset }))
  const npcs = reversed('npc', sector.npcs.length)
  const monsters = reversed('monsterSpawn', sector.monsterSpawns.length)
  const portals = reversed('portal', sector.portals.length)
  const masks = reversed('mask', sector.collisionMasks.length)
  const objects = reversed('object', sector.objects.length)
  const floorPatches = reversed('floorPatch', sector.floorPatches.length)
  switch (tool) {
    case 'select':
      return [...npcs, ...monsters, ...portals, ...masks, ...objects, ...floorPatches]
    case 'object':
      return objects
    case 'mask':
      return masks
    case 'portal':
      return portals
    case 'npc':
      return npcs
    case 'monster':
      return monsters
    case 'floorPatch':
      return floorPatches
  }
}

export function selectRecord(
  point: GridPoint,
  sector: Sector,
  tool: EditorTool
): EditorSelection | undefined {
  for (const candidate of candidateSelections(sector, tool)) {
    const bounds = selectionBounds(candidate, sector)
    if (bounds === undefined) continue
    if (
      point.x >= bounds.origin.x &&
      point.x < bounds.origin.x + bounds.size.width &&
      point.y >= bounds.origin.y &&
      point.y < bounds.origin.y + bounds.size.height
    ) {
      return candidate
    }
  }
  return undefined
}
