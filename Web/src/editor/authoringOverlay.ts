import * as THREE from 'three'
import { ORTHO_RIG, worldPosition } from '@/scene/cameraRig'
import type { GridPoint, GridSize } from '@/core/geometry'
import { SOMNIO_CONSTANTS } from '@/core/constants'
import type { Sector } from '@/core/sector'

/**
 * Flat unlit rects on the floor for the authored record geometry, a border highlight per
 * selected record, the resize/facing handles for a single selection, and the optional grid.
 * Rebuilt from scratch on every update: the per-refresh cost is negligible at editor scale,
 * and diffing would couple the overlay to the sector's shape.
 *
 * **Rebuild on camera change, not only on document change**: the handle and border constants
 * are screen-constant points, so their world-space geometry is computed through a
 * pixels-per-point factor that changes with every zoom — the caller passes the handle
 * extents pre-converted and re-runs `update` on zoom and viewport resize.
 *
 * The elevation stack sits above `FLOOR_PATCH_LIFT` (0.002) because floor patches are an
 * authored **mesh**: the patch gizmo is the first that must clear another authored mesh
 * rather than only the floor plane, so it sits just above the patch lift and every layer
 * above it stacks up in order. Gizmos at these elevations are occluded by tall props.
 */

const ELEVATION = {
  floorPatches: 0.004,
  masks: 0.006,
  portals: 0.008,
  spawns: 0.01,
  grid: 0.012,
  selection: 0.014,
  handles: 0.016,
} as const

const SELECTION_BORDER_THICKNESS_PX = 2
/** Grid lines sit under the busy floor material, so they carry more weight than a hairline. */
const GRID_LINE_THICKNESS_PX = 2
const GRID_LINE_OPACITY = 0.35
/**
 * Record rects stay in the hundreds, but grid lines scale with sector pixels ÷ snap step —
 * past this cap the grid is skipped (at that density it is unreadable noise anyway).
 */
const MAX_GRID_LINES = 512

const COLOR = {
  mask: 0xff0000,
  outboundPortal: 0x0000ff,
  arrivalPortal: 0x30b0c7,
  npcSpawn: 0x00ff00,
  monsterSpawn: 0xff8000,
  floorPatch: 0xc060ff,
  selection: 0xffff00,
  facing: 0x00ffff,
  grid: 0xffffff,
} as const

export interface AuthoringHandleSet {
  centerPixels: { x: number; y: number }[]
  extentPx: number
}

export interface AuthoringFacingHandle {
  centerPixel: { x: number; y: number }
  handlePixel: { x: number; y: number }
  extentPx: number
}

export interface AuthoringOverlayInput {
  sector: Sector
  selectionBounds: { origin: GridPoint; size: GridSize }[]
  resizeHandles?: AuthoringHandleSet | undefined
  facingHandle?: AuthoringFacingHandle | undefined
  showGrid: boolean
  gridStepPx: number
}

export class AuthoringOverlay {
  /** Added to the world scene once by the shell; contents are replaced per update. */
  readonly root = new THREE.Group()

  update(input: AuthoringOverlayInput): void {
    this.clear()

    for (const patch of input.sector.floorPatches) {
      this.root.add(
        filledRect(
          { x: patch.x, y: patch.y },
          { width: patch.width, height: patch.height },
          COLOR.floorPatch,
          0.2,
          ELEVATION.floorPatches
        )
      )
    }
    for (const mask of input.sector.collisionMasks) {
      this.root.add(
        filledRect(
          { x: mask.x, y: mask.y },
          { width: mask.width, height: mask.height },
          COLOR.mask,
          0.25,
          ELEVATION.masks
        )
      )
    }
    for (const portal of input.sector.portals) {
      this.root.add(
        filledRect(
          { x: portal.x, y: portal.y },
          { width: portal.width, height: portal.height },
          portal.direction === 'outboundTrigger' ? COLOR.outboundPortal : COLOR.arrivalPortal,
          0.2,
          ELEVATION.portals
        )
      )
    }
    for (const npc of input.sector.npcs) {
      this.root.add(filledRect(npc.spawnOrigin, npc.spawnBoxSize, COLOR.npcSpawn, 0.2, ELEVATION.spawns))
    }
    for (const spawn of input.sector.monsterSpawns) {
      this.root.add(
        filledRect(spawn.spawnOrigin, spawn.spawnBoxSize, COLOR.monsterSpawn, 0.2, ELEVATION.spawns)
      )
    }

    if (input.showGrid) {
      const grid = gridLines(input.sector.dimensions, input.gridStepPx)
      if (grid !== undefined) this.root.add(grid)
    }

    for (const bounds of input.selectionBounds) {
      this.root.add(selectionBorder(bounds.origin, bounds.size))
    }

    if (input.resizeHandles !== undefined) {
      this.root.add(resizeHandles(input.resizeHandles))
    }
    if (input.facingHandle !== undefined) {
      this.root.add(facingHandle(input.facingHandle))
    }
  }

  dispose(): void {
    this.clear()
    this.root.removeFromParent()
  }

  /**
   * Every plane here owns its geometry and material (no textures), so rebuild disposal is a
   * plain traverse — following `worldScene.ts`'s rule that a detached subtree releases what
   * it allocated.
   */
  private clear(): void {
    for (const child of [...this.root.children]) {
      child.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (!mesh.isMesh) return
        mesh.geometry.dispose()
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          material.dispose()
        }
      })
      this.root.remove(child)
    }
  }

  /** Test seam mirroring `_authoringOverlayChildCount`. */
  _childCount(): number {
    return this.root.children.length
  }

  /** Test seam: the grid container's line count, or `undefined` when no grid is present. */
  _gridLineCount(): number | undefined {
    const grid = this.root.children.find((child) => child.name === GRID_NAME)
    return grid?.children.length
  }
}

const GRID_NAME = 'authoring-grid'

/**
 * Translucent unlit plane over a record's authored pixel rect. Zero/negative extents (an
 * invalidated record mid-edit) yield an empty placeholder rather than a degenerate plane.
 */
function filledRect(
  origin: GridPoint,
  size: GridSize,
  color: number,
  opacity: number,
  elevation: number
): THREE.Object3D {
  return floorPlane(
    { x: origin.x + size.width / 2, y: origin.y + size.height / 2 },
    { x: size.width, y: size.height },
    color,
    opacity,
    elevation
  )
}

/** Four opaque yellow strips outlining the selection bounds — readable over the filled rect. */
function selectionBorder(origin: GridPoint, size: GridSize): THREE.Object3D {
  const border = new THREE.Group()
  const thickness = SELECTION_BORDER_THICKNESS_PX
  const edges = [
    {
      center: { x: origin.x + size.width / 2, y: origin.y },
      size: { x: size.width + thickness, y: thickness },
    },
    {
      center: { x: origin.x + size.width / 2, y: origin.y + size.height },
      size: { x: size.width + thickness, y: thickness },
    },
    {
      center: { x: origin.x, y: origin.y + size.height / 2 },
      size: { x: thickness, y: size.height + thickness },
    },
    {
      center: { x: origin.x + size.width, y: origin.y + size.height / 2 },
      size: { x: thickness, y: size.height + thickness },
    },
  ]
  for (const edge of edges) {
    border.add(floorPlane(edge.center, edge.size, COLOR.selection, 1, ELEVATION.selection))
  }
  return border
}

/** Small filled squares at the handle centers the drag layer computed. */
function resizeHandles(handles: AuthoringHandleSet): THREE.Object3D {
  const node = new THREE.Group()
  for (const center of handles.centerPixels) {
    node.add(
      floorPlane(center, { x: handles.extentPx, y: handles.extentPx }, COLOR.selection, 1, ELEVATION.handles)
    )
  }
  return node
}

/** The NPC facing affordance: a tether strip plus a filled square at the handle. */
function facingHandle(handle: AuthoringFacingHandle): THREE.Object3D {
  const node = new THREE.Group()
  const dx = handle.handlePixel.x - handle.centerPixel.x
  const dy = handle.handlePixel.y - handle.centerPixel.y
  const length = Math.hypot(dx, dy)
  if (length > 0) {
    const strip = floorPlane(
      {
        x: (handle.centerPixel.x + handle.handlePixel.x) / 2,
        y: (handle.centerPixel.y + handle.handlePixel.y) / 2,
      },
      { x: SELECTION_BORDER_THICKNESS_PX, y: length },
      COLOR.facing,
      1,
      ELEVATION.handles
    )
    strip.rotation.y = Math.atan2(dx, dy)
    node.add(strip)
  }
  node.add(
    floorPlane(
      handle.handlePixel,
      { x: handle.extentPx, y: handle.extentPx },
      COLOR.facing,
      1,
      ELEVATION.handles
    )
  )
  return node
}

/**
 * `undefined` (no grid child at all) for degenerate inputs or when the line count would
 * exceed the cap, so overlay child counts stay meaningful around it.
 */
function gridLines(sectorSize: GridSize, stepPx: number): THREE.Object3D | undefined {
  const widthPx = sectorSize.width * SOMNIO_CONSTANTS.tileSize
  const heightPx = sectorSize.height * SOMNIO_CONSTANTS.tileSize
  if (stepPx <= 0 || widthPx <= 0 || heightPx <= 0) return undefined
  if (Math.trunc((widthPx + heightPx) / stepPx) + 2 > MAX_GRID_LINES) return undefined
  const grid = new THREE.Group()
  grid.name = GRID_NAME
  for (let x = 0; x <= widthPx; x += stepPx) {
    grid.add(
      floorPlane(
        { x, y: heightPx / 2 },
        { x: GRID_LINE_THICKNESS_PX, y: heightPx },
        COLOR.grid,
        GRID_LINE_OPACITY,
        ELEVATION.grid
      )
    )
  }
  for (let y = 0; y <= heightPx; y += stepPx) {
    grid.add(
      floorPlane(
        { x: widthPx / 2, y },
        { x: widthPx, y: GRID_LINE_THICKNESS_PX },
        COLOR.grid,
        GRID_LINE_OPACITY,
        ELEVATION.grid
      )
    )
  }
  return grid
}

/**
 * A flat quad on the floor plane at the given pixel center. Parent group carries position
 * and (for the tether) the yaw; the child mesh carries only the lie-flat rotation, so the
 * two rotations compose without Euler-order surprises. Tone-mapping off, as on the Swift
 * overlay material — selection yellow against facing cyan is a meaning-carrying distinction,
 * not scene luminance.
 */
function floorPlane(
  centerPixel: { x: number; y: number },
  sizePx: { x: number; y: number },
  color: number,
  opacity: number,
  elevation: number
): THREE.Object3D {
  const group = new THREE.Group()
  if (sizePx.x <= 0 || sizePx.y <= 0) return group
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    toneMapped: false,
    depthWrite: false,
  })
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(sizePx.x * ORTHO_RIG.worldUnitsPerPixel, sizePx.y * ORTHO_RIG.worldUnitsPerPixel),
    material
  )
  mesh.rotation.x = -Math.PI / 2
  group.add(mesh)
  const position = worldPosition(centerPixel.x, centerPixel.y)
  group.position.set(position.x, elevation, position.z)
  return group
}
