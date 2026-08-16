import type * as THREE from 'three'
import { clampToInt16 } from '@/core/geometry'
import type { GridPoint, GridSize } from '@/core/geometry'
import { angularDistance, headingFromVector, headingRadians } from '@/core/heading'
import type { Heading } from '@/core/heading'
import type { Sector } from '@/core/sector'
import { ORTHO_RIG } from '@/scene/cameraRig'
import { floorPixelAtScreen, screenAtFloorPixel } from './picking'
import type { ScreenPoint, ViewportSize } from './picking'
import { quantize } from './preferences'
import { candidateSelections, gridPoint, selectRecord } from './canvasController'
import type { EditorTool } from './canvasController'
import { containsSelection, selectionBounds, toggleSelection } from './selection'
import type { EditorSelection } from './selection'

/**
 * The stateless drag interaction layer: session classification in fixed precedence (NPC facing handle → resize
 * handles → Shift-toggle → marquee/move), live previews, and committed record mutations.
 * All coordinate arithmetic clamps back into the Int16 grid so a drag at the coordinate
 * limits clamps instead of overflowing.
 */

/** Drawn extent of the resize/facing handles, in viewport points. */
export const HANDLE_DRAW_EXTENT_PT = 8
/** Hit-test extent around each handle center — larger than the drawn square. */
export const HANDLE_HIT_EXTENT_PT = 14
/** Screen clearance between the NPC spawn box and its facing handle. */
export const FACING_CLEARANCE_PT = 24
/** A gesture travelling less than this is a tap: placement drops the default footprint. */
export const TAP_TRANSLATION_THRESHOLD_PT = 4

export const DEFAULT_FOOTPRINT: GridSize = { width: 128, height: 128 }

export type ResizeHandle =
  'topLeft' | 'top' | 'topRight' | 'left' | 'right' | 'bottomLeft' | 'bottom' | 'bottomRight'

const RESIZE_HANDLES: readonly ResizeHandle[] = [
  'topLeft',
  'top',
  'topRight',
  'left',
  'right',
  'bottomLeft',
  'bottom',
  'bottomRight',
]

function movesLeftEdge(handle: ResizeHandle): boolean {
  return handle === 'topLeft' || handle === 'left' || handle === 'bottomLeft'
}
function movesRightEdge(handle: ResizeHandle): boolean {
  return handle === 'topRight' || handle === 'right' || handle === 'bottomRight'
}
function movesTopEdge(handle: ResizeHandle): boolean {
  return handle === 'topLeft' || handle === 'top' || handle === 'topRight'
}
function movesBottomEdge(handle: ResizeHandle): boolean {
  return handle === 'bottomLeft' || handle === 'bottom' || handle === 'bottomRight'
}

/**
 * In-flight canvas drag, classified once at the gesture's first change. Move snapshots every
 * selected record's origin at press time so the live delta always applies to the pre-drag
 * geometry; resize snapshots the grabbed record's bounds for the same reason.
 */
export type DragSession =
  | { kind: 'placement'; tool: EditorTool; anchor: GridPoint }
  | { kind: 'move'; originals: { selection: EditorSelection; origin: GridPoint }[] }
  | { kind: 'resize'; selection: EditorSelection; handle: ResizeHandle; origin: GridPoint; size: GridSize }
  | { kind: 'rotate'; npcIndex: number }
  | { kind: 'marquee' }

/** The projection context every screen-space step needs. */
export interface DragContext {
  camera: THREE.OrthographicCamera
  viewport: ViewportSize
  gridStep: number
}

/** Per-kind seeds for direct placement; ids come from the committed registry. */
export interface PlacementDefaults {
  objectModelID: string
  floorMaterialID: string
}

// MARK: - Session classification

/**
 * Classifies a gesture's first change into a session, possibly retargeting the selection.
 * Edit handles keep precedence over Shift — Shift+handle stays a resize/rotate grab.
 */
export function beginSession(
  location: ScreenPoint,
  tool: EditorTool,
  additive: boolean,
  sector: Sector,
  selection: readonly EditorSelection[],
  context: DragContext
): { session: DragSession | undefined; selection: EditorSelection[] } {
  if (tool !== 'select') {
    const grid = gridPoint(context.camera, context.viewport, location)
    const anchor = {
      x: quantize(grid.x, context.gridStep),
      y: quantize(grid.y, context.gridStep),
    }
    return { session: { kind: 'placement', tool, anchor }, selection: [...selection] }
  }

  if (selection.length === 1) {
    const selected = selection[0]!
    if (selected.kind === 'npc') {
      const npc = sector.npcs[selected.index]
      if (npc !== undefined) {
        const clearancePx = FACING_CLEARANCE_PT * legacyPixelsPerViewportPoint(context)
        const handlePixel = facingHandlePixel(npc.spawnOrigin, npc.spawnBoxSize, npc.facing, clearancePx)
        if (handleHitRect(handlePixel, context).contains(location)) {
          return { session: { kind: 'rotate', npcIndex: selected.index }, selection: [...selection] }
        }
      }
    }
    const bounds = selectionBounds(selected, sector)
    if (bounds !== undefined) {
      const handle = hitHandle(location, bounds.origin, bounds.size, context)
      if (handle !== undefined) {
        return {
          session: {
            kind: 'resize',
            selection: selected,
            handle,
            origin: bounds.origin,
            size: bounds.size,
          },
          selection: [...selection],
        }
      }
    }
  }

  const point = gridPoint(context.camera, context.viewport, location)
  if (additive) {
    const picked = selectRecord(point, sector, 'select')
    if (picked === undefined) return { session: { kind: 'marquee' }, selection: [...selection] }
    return { session: undefined, selection: toggleSelection(selection, picked) }
  }
  // Resolve the topmost record at the point first: pressing a record that overlaps the
  // current selection must manipulate what is visibly under the cursor.
  const picked = selectRecord(point, sector, 'select')
  if (picked === undefined) return { session: { kind: 'marquee' }, selection: [] }
  if (containsSelection(selection, picked)) {
    return { session: { kind: 'move', originals: origins(selection, sector) }, selection: [...selection] }
  }
  return { session: { kind: 'move', originals: origins([picked], sector) }, selection: [picked] }
}

// MARK: - Live preview

/**
 * The transient sector a live drag should render, or `undefined` when the session has no
 * floor-space preview (marquee draws a viewport rect instead).
 */
export function preview(
  session: DragSession,
  start: ScreenPoint,
  current: ScreenPoint,
  sector: Sector,
  context: DragContext,
  defaults: PlacementDefaults
): Sector | undefined {
  switch (session.kind) {
    case 'placement': {
      const transient = structuredClone(sector)
      const bounds = placementBounds(session.tool, session.anchor, start, current, context)
      placeRecord(session.tool, bounds.origin, bounds.size, transient, defaults)
      return transient
    }
    case 'move': {
      const delta = gridDelta(start, current, context)
      const transient = structuredClone(sector)
      applyMove(session.originals, delta.dx, delta.dy, transient)
      return transient
    }
    case 'resize': {
      const delta = gridDelta(start, current, context)
      const bounds = resizedBounds(
        session.origin,
        session.size,
        session.handle,
        delta.dx,
        delta.dy,
        Math.max(1, context.gridStep)
      )
      const transient = structuredClone(sector)
      applyBounds(session.selection, bounds.origin, bounds.size, transient)
      return transient
    }
    case 'rotate': {
      const npc = sector.npcs[session.npcIndex]
      if (npc === undefined) return undefined
      const transient = structuredClone(sector)
      transient.npcs[session.npcIndex]!.facing = headingFromDrag(current, npc, context)
      return transient
    }
    case 'marquee':
      return undefined
  }
}

// MARK: - Commit

export interface DragCommitTarget {
  mutate(actionName: string, change: (sector: Sector) => void): void
}

/**
 * Commits a finished drag: placement appends and selects the new record; move/resize/rotate
 * write one mutation each (no-op when the drag came back to its origin); marquee resolves
 * the viewport rect into a selection set. Returns the selection after the commit.
 */
export function endSession(
  session: DragSession,
  start: ScreenPoint,
  end: ScreenPoint,
  additive: boolean,
  document: DragCommitTarget,
  sector: Sector,
  selection: readonly EditorSelection[],
  context: DragContext,
  defaults: PlacementDefaults
): EditorSelection[] {
  switch (session.kind) {
    case 'placement': {
      const bounds = placementBounds(session.tool, session.anchor, start, end, context)
      let placed: EditorSelection | undefined
      document.mutate(placementDescription(session.tool), (draft) => {
        placed = placeRecord(session.tool, bounds.origin, bounds.size, draft, defaults)
      })
      return placed === undefined ? [...selection] : [placed]
    }
    case 'move': {
      const delta = gridDelta(start, end, context)
      if (delta.dx === 0 && delta.dy === 0) return [...selection]
      document.mutate('Move selection', (draft) => {
        applyMove(session.originals, delta.dx, delta.dy, draft)
      })
      return [...selection]
    }
    case 'resize': {
      const delta = gridDelta(start, end, context)
      if (delta.dx === 0 && delta.dy === 0) return [...selection]
      const bounds = resizedBounds(
        session.origin,
        session.size,
        session.handle,
        delta.dx,
        delta.dy,
        Math.max(1, context.gridStep)
      )
      document.mutate('Resize selection', (draft) => {
        applyBounds(session.selection, bounds.origin, bounds.size, draft)
      })
      return [...selection]
    }
    case 'rotate': {
      commitRotation(session.npcIndex, end, document, sector, context)
      return [...selection]
    }
    case 'marquee': {
      // A tap-sized marquee is just a click on empty ground: the deselection already happened
      // in `beginSession`, and a zero-size rect must not intersect-select whatever record's
      // projection happens to pass under the point.
      if (Math.hypot(end.x - start.x, end.y - start.y) < TAP_TRANSLATION_THRESHOLD_PT) {
        return [...selection]
      }
      const rect = {
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
      }
      const hits = marqueeSelections(sector, rect, context)
      if (!additive) return hits
      const merged = [...selection]
      for (const hit of hits) {
        if (!containsSelection(merged, hit)) merged.push(hit)
      }
      return merged
    }
  }
}

/**
 * A grab that comes back to (essentially) the current heading is a no-op — committing it
 * would register a do-nothing undo entry for every handle click.
 */
function commitRotation(
  index: number,
  end: ScreenPoint,
  document: DragCommitTarget,
  sector: Sector,
  context: DragContext
): void {
  const npc = sector.npcs[index]
  if (npc === undefined) return
  const facing = headingFromDrag(end, npc, context)
  if (Math.abs(angularDistance(facing, npc.facing)) <= 0.01) return
  document.mutate('Rotate NPC', (draft) => {
    const target = draft.npcs[index]
    if (target !== undefined) target.facing = facing
  })
}

// MARK: - Geometry

/**
 * Legacy pixels covered by one viewport point at the given framing: the orthographic scale
 * is the view volume's vertical HALF-height, so the viewport height spans `2 x scale` meters.
 * Derived from the live camera so drawing and hit-testing cannot disagree.
 */
export function legacyPixelsPerViewportPoint(context: DragContext): number {
  if (context.viewport.height <= 0) return 1
  const scale = context.camera.top
  return (scale * 2) / context.viewport.height / ORTHO_RIG.worldUnitsPerPixel
}

/**
 * Quantized grid delta between two viewport points. Quantizing the delta (not the endpoints)
 * keeps a group move's relative offsets intact.
 */
export function gridDelta(
  start: ScreenPoint,
  end: ScreenPoint,
  context: DragContext
): { dx: number; dy: number } {
  const from = floorPixelAtScreen(context.camera, context.viewport, start)
  const to = floorPixelAtScreen(context.camera, context.viewport, end)
  const rawX = Math.round(to.x - from.x)
  const rawY = Math.round(to.y - from.y)
  if (context.gridStep <= 0) return { dx: rawX, dy: rawY }
  return {
    dx: Math.trunc(rawX / context.gridStep) * context.gridStep,
    dy: Math.trunc(rawY / context.gridStep) * context.gridStep,
  }
}

/**
 * Bounds a placement drag resolves to: a tap (or an NPC/monster press, whose spawn box is
 * refined in the inspector) drops the default one-tile footprint at the anchor; a rubber-band
 * drag spans anchor→end, at least one snap step per axis.
 */
export function placementBounds(
  tool: EditorTool,
  anchor: GridPoint,
  start: ScreenPoint,
  end: ScreenPoint,
  context: DragContext
): { origin: GridPoint; size: GridSize } {
  const translation = Math.hypot(end.x - start.x, end.y - start.y)
  switch (tool) {
    case 'select':
    case 'npc':
    case 'monster':
      return { origin: anchor, size: { ...DEFAULT_FOOTPRINT } }
    case 'object':
    case 'mask':
    case 'portal':
    case 'floorPatch': {
      if (translation < TAP_TRANSLATION_THRESHOLD_PT) {
        return { origin: anchor, size: { ...DEFAULT_FOOTPRINT } }
      }
      const grid = gridPoint(context.camera, context.viewport, end)
      const far = {
        x: quantize(grid.x, context.gridStep),
        y: quantize(grid.y, context.gridStep),
      }
      return rubberBandBounds(anchor, far, Math.max(1, context.gridStep))
    }
  }
}

/** Normalized rect between two quantized grid points, at least `minExtent` per axis. */
export function rubberBandBounds(
  anchor: GridPoint,
  point: GridPoint,
  minExtent: number
): { origin: GridPoint; size: GridSize } {
  const minX = Math.min(anchor.x, point.x)
  const minY = Math.min(anchor.y, point.y)
  const width = Math.max(Math.abs(point.x - anchor.x), minExtent)
  const height = Math.max(Math.abs(point.y - anchor.y), minExtent)
  return {
    origin: { x: clampToInt16(minX), y: clampToInt16(minY) },
    size: { width: clampToInt16(width), height: clampToInt16(height) },
  }
}

/**
 * Bounds after dragging one handle by a quantized delta. The moved edge clamps into the
 * Int16 domain (and to a representable extent) BEFORE the extent is derived — clamping
 * origin and size independently at return would shift the supposedly fixed opposite edge.
 * The minimum-extent floor is re-applied last, so a record whose fixed edge already sits at
 * the domain edge keeps its floor rather than collapsing to zero.
 */
export function resizedBounds(
  origin: GridPoint,
  size: GridSize,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  minExtent: number
): { origin: GridPoint; size: GridSize } {
  const INT16_MIN = -32_768
  const INT16_MAX = 32_767
  let minX = origin.x
  let minY = origin.y
  let maxX = minX + size.width
  let maxY = minY + size.height
  if (movesLeftEdge(handle)) {
    minX = Math.min(minX + dx, maxX - minExtent)
    minX = Math.min(Math.max(minX, INT16_MIN, maxX - INT16_MAX), maxX - minExtent)
  }
  if (movesRightEdge(handle)) {
    maxX = Math.max(maxX + dx, minX + minExtent)
    maxX = Math.max(Math.min(maxX, INT16_MAX, minX + INT16_MAX), minX + minExtent)
  }
  if (movesTopEdge(handle)) {
    minY = Math.min(minY + dy, maxY - minExtent)
    minY = Math.min(Math.max(minY, INT16_MIN, maxY - INT16_MAX), maxY - minExtent)
  }
  if (movesBottomEdge(handle)) {
    maxY = Math.max(maxY + dy, minY + minExtent)
    maxY = Math.max(Math.min(maxY, INT16_MAX, minY + INT16_MAX), minY + minExtent)
  }
  return {
    origin: { x: clampToInt16(minX), y: clampToInt16(minY) },
    size: { width: clampToInt16(maxX - minX), height: clampToInt16(maxY - minY) },
  }
}

/**
 * The 8 handle centers on a record's bounds, in legacy pixels. Hit-testing projects these,
 * and the overlay draws the same centers, so the visible and grabbable handles cannot drift.
 */
export function handleCenters(
  origin: GridPoint,
  size: GridSize
): { handle: ResizeHandle; pixel: { x: number; y: number } }[] {
  const minX = origin.x
  const minY = origin.y
  const maxX = minX + size.width
  const maxY = minY + size.height
  const midX = (minX + maxX) / 2
  const midY = (minY + maxY) / 2
  const centers: Record<ResizeHandle, { x: number; y: number }> = {
    topLeft: { x: minX, y: minY },
    top: { x: midX, y: minY },
    topRight: { x: maxX, y: minY },
    left: { x: minX, y: midY },
    right: { x: maxX, y: midY },
    bottomLeft: { x: minX, y: maxY },
    bottom: { x: midX, y: maxY },
    bottomRight: { x: maxX, y: maxY },
  }
  return RESIZE_HANDLES.map((handle) => ({ handle, pixel: centers[handle] }))
}

/** The handle under a viewport point, if any. */
export function hitHandle(
  location: ScreenPoint,
  origin: GridPoint,
  size: GridSize,
  context: DragContext
): ResizeHandle | undefined {
  for (const { handle, pixel } of handleCenters(origin, size)) {
    if (handleHitRect(pixel, context).contains(location)) return handle
  }
  return undefined
}

interface HitRect {
  contains(point: ScreenPoint): boolean
}

/** Constant-screen-size hit rect centered on a legacy pixel's viewport projection. */
export function handleHitRect(pixel: { x: number; y: number }, context: DragContext): HitRect {
  const projected = screenAtFloorPixel(context.camera, context.viewport, pixel)
  const half = HANDLE_HIT_EXTENT_PT / 2
  return {
    contains: (point) =>
      point.x >= projected.x - half &&
      point.x <= projected.x + half &&
      point.y >= projected.y - half &&
      point.y <= projected.y + half,
  }
}

/**
 * Viewport-space corners of a record's floor bounds, in edge order — the tilted camera maps
 * the floor rect to a rotated convex quad on screen.
 */
export function projectedCorners(origin: GridPoint, size: GridSize, context: DragContext): ScreenPoint[] {
  const minX = origin.x
  const minY = origin.y
  const maxX = minX + size.width
  const maxY = minY + size.height
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ].map((pixel) => screenAtFloorPixel(context.camera, context.viewport, pixel))
}

/**
 * Every record whose projected quad intersects the marquee rect. The quad itself is tested
 * (separating axes), not its bounding box — a rotated floor rect's bounding box covers far
 * more screen than the record and would marquee-select across empty ground.
 */
export function marqueeSelections(
  sector: Sector,
  rect: { x: number; y: number; width: number; height: number },
  context: DragContext
): EditorSelection[] {
  const hits: EditorSelection[] = []
  for (const candidate of candidateSelections(sector, 'select')) {
    const bounds = selectionBounds(candidate, sector)
    if (bounds === undefined) continue
    const quad = projectedCorners(bounds.origin, bounds.size, context)
    if (rectIntersectsConvexQuad(rect, quad)) hits.push(candidate)
  }
  return hits
}

/**
 * Separating-axis intersection between an axis-aligned rect and a convex quad given in edge
 * order: the shapes overlap unless some axis — the rect's two, or a quad edge normal —
 * separates their projections.
 */
export function rectIntersectsConvexQuad(
  rect: { x: number; y: number; width: number; height: number },
  quad: readonly ScreenPoint[]
): boolean {
  const rectCorners: ScreenPoint[] = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ]
  const axes: ScreenPoint[] = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
  ]
  for (let index = 0; index < quad.length; index += 1) {
    const current = quad[index]!
    const next = quad[(index + 1) % quad.length]!
    axes.push({ x: current.y - next.y, y: next.x - current.x })
  }
  for (const axis of axes) {
    const span = (points: readonly ScreenPoint[]): { min: number; max: number } => {
      const projections = points.map((point) => point.x * axis.x + point.y * axis.y)
      return { min: Math.min(...projections), max: Math.max(...projections) }
    }
    const rectSpan = span(rectCorners)
    const quadSpan = span(quad)
    if (rectSpan.max < quadSpan.min || quadSpan.max < rectSpan.min) return false
  }
  return true
}

/**
 * Heading of the drag point around the NPC's spawn-box center, computed in legacy floor
 * coordinates — the tilted camera rotates/scales the floor axes on screen, so a
 * viewport-space vector would yield a wrong angle.
 */
export function headingFromDrag(
  location: ScreenPoint,
  npc: { spawnOrigin: GridPoint; spawnBoxSize: GridSize; facing: Heading },
  context: DragContext
): Heading {
  const point = floorPixelAtScreen(context.camera, context.viewport, location)
  const center = spawnBoxCenter(npc.spawnOrigin, npc.spawnBoxSize)
  const dx = point.x - center.x
  const dy = point.y - center.y
  if (dx === 0 && dy === 0) return npc.facing
  return headingFromVector(dx, dy)
}

export function spawnBoxCenter(origin: GridPoint, size: GridSize): { x: number; y: number } {
  return { x: origin.x + size.width / 2, y: origin.y + size.height / 2 }
}

/**
 * The facing handle's legacy-pixel position: offset from the spawn-box center along the
 * heading, cleared past the box's half extent so it never sits inside the rect.
 */
export function facingHandlePixel(
  origin: GridPoint,
  size: GridSize,
  facing: Heading,
  clearancePx: number
): { x: number; y: number } {
  const center = spawnBoxCenter(origin, size)
  const halfExtent = Math.max(size.width, size.height) / 2
  const radians = headingRadians(facing)
  return {
    x: center.x + Math.sin(radians) * (halfExtent + clearancePx),
    y: center.y + Math.cos(radians) * (halfExtent + clearancePx),
  }
}

// MARK: - Record mutation

/** Origin snapshot of every selected record, taken at press time. */
export function origins(
  selections: readonly EditorSelection[],
  sector: Sector
): { selection: EditorSelection; origin: GridPoint }[] {
  const snapshots: { selection: EditorSelection; origin: GridPoint }[] = []
  for (const selection of selections) {
    const bounds = selectionBounds(selection, sector)
    if (bounds !== undefined) snapshots.push({ selection, origin: bounds.origin })
  }
  return snapshots
}

/** Shifts every snapshotted origin by the quantized delta, clamped back into the Int16 grid. */
export function applyMove(
  originals: readonly { selection: EditorSelection; origin: GridPoint }[],
  dx: number,
  dy: number,
  sector: Sector
): void {
  for (const { selection, origin } of originals) {
    const moved = { x: clampToInt16(origin.x + dx), y: clampToInt16(origin.y + dy) }
    switch (selection.kind) {
      case 'object': {
        const object = sector.objects[selection.index]
        if (object !== undefined) {
          object.x = moved.x
          object.y = moved.y
        }
        break
      }
      case 'mask': {
        const mask = sector.collisionMasks[selection.index]
        if (mask !== undefined) {
          mask.x = moved.x
          mask.y = moved.y
        }
        break
      }
      case 'portal': {
        const portal = sector.portals[selection.index]
        if (portal !== undefined) {
          portal.x = moved.x
          portal.y = moved.y
        }
        break
      }
      case 'npc': {
        const npc = sector.npcs[selection.index]
        if (npc !== undefined) npc.spawnOrigin = moved
        break
      }
      case 'monsterSpawn': {
        const spawn = sector.monsterSpawns[selection.index]
        if (spawn !== undefined) spawn.spawnOrigin = moved
        break
      }
      case 'floorPatch': {
        const patch = sector.floorPatches[selection.index]
        if (patch !== undefined) {
          patch.x = moved.x
          patch.y = moved.y
        }
        break
      }
    }
  }
}

/**
 * Writes resized bounds back to the selected record (an NPC/monster selection resizes its
 * spawn box; the inspector refines the other size fields).
 */
export function applyBounds(
  selection: EditorSelection,
  origin: GridPoint,
  size: GridSize,
  sector: Sector
): void {
  switch (selection.kind) {
    case 'object': {
      const object = sector.objects[selection.index]
      if (object !== undefined) {
        object.x = origin.x
        object.y = origin.y
        object.sourceWidth = size.width
        object.sourceHeight = size.height
      }
      break
    }
    case 'mask': {
      const mask = sector.collisionMasks[selection.index]
      if (mask !== undefined) {
        mask.x = origin.x
        mask.y = origin.y
        mask.width = size.width
        mask.height = size.height
      }
      break
    }
    case 'portal': {
      const portal = sector.portals[selection.index]
      if (portal !== undefined) {
        portal.x = origin.x
        portal.y = origin.y
        portal.width = size.width
        portal.height = size.height
      }
      break
    }
    case 'npc': {
      const npc = sector.npcs[selection.index]
      if (npc !== undefined) {
        npc.spawnOrigin = origin
        npc.spawnBoxSize = size
      }
      break
    }
    case 'monsterSpawn': {
      const spawn = sector.monsterSpawns[selection.index]
      if (spawn !== undefined) {
        spawn.spawnOrigin = origin
        spawn.spawnBoxSize = size
      }
      break
    }
    case 'floorPatch': {
      const patch = sector.floorPatches[selection.index]
      if (patch !== undefined) {
        patch.x = origin.x
        patch.y = origin.y
        patch.width = size.width
        patch.height = size.height
      }
      break
    }
  }
}

/**
 * Appends a freshly placed record with the default field values, returning its selection
 * (the inspector then refines the fields in place). Seeds mirror the Swift `placeRecord`,
 * plus the floor-patch seed the sixth kind adds.
 */
export function placeRecord(
  tool: EditorTool,
  origin: GridPoint,
  size: GridSize,
  sector: Sector,
  defaults: PlacementDefaults
): EditorSelection | undefined {
  switch (tool) {
    case 'select':
      return undefined
    case 'object':
      sector.objects.push({
        x: origin.x,
        y: origin.y,
        modelID: defaults.objectModelID,
        sourceWidth: size.width,
        sourceHeight: size.height,
        priority: 0,
        rotation: 0,
      })
      return { kind: 'object', index: sector.objects.length - 1 }
    case 'mask':
      sector.collisionMasks.push({ x: origin.x, y: origin.y, width: size.width, height: size.height })
      return { kind: 'mask', index: sector.collisionMasks.length - 1 }
    case 'portal':
      sector.portals.push({
        x: origin.x,
        y: origin.y,
        width: size.width,
        height: size.height,
        targetSectorName: '',
        direction: 'outboundTrigger',
      })
      return { kind: 'portal', index: sector.portals.length - 1 }
    case 'npc':
      sector.npcs.push({
        spawnOrigin: origin,
        spawnBoxSize: size,
        maskSize: { ...DEFAULT_FOOTPRINT },
        name: '',
        figure: 0,
        facing: 0,
        behaviorTag: 0,
        dialogScript: '',
      })
      return { kind: 'npc', index: sector.npcs.length - 1 }
    case 'monster':
      sector.monsterSpawns.push({
        spawnOrigin: origin,
        spawnBoxSize: size,
        spawnedMonsterSize: { ...DEFAULT_FOOTPRINT },
        name: '',
        figure: 0,
        bounded: true,
        spawnHP: 100,
        spawnBalance: 100,
        spawnMana: 100,
        aiScriptIndex: 0,
      })
      return { kind: 'monsterSpawn', index: sector.monsterSpawns.length - 1 }
    case 'floorPatch':
      sector.floorPatches.push({
        floorMaterialID: defaults.floorMaterialID,
        x: origin.x,
        y: origin.y,
        width: size.width,
        height: size.height,
      })
      return { kind: 'floorPatch', index: sector.floorPatches.length - 1 }
  }
}

export function placementDescription(tool: EditorTool): string {
  switch (tool) {
    case 'select':
    case 'object':
      return 'Place object'
    case 'mask':
      return 'Place collision mask'
    case 'portal':
      return 'Place sector portal'
    case 'npc':
      return 'Place NPC'
    case 'monster':
      return 'Place monster spawn'
    case 'floorPatch':
      return 'Place floor patch'
  }
}
