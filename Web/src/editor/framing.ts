import type * as THREE from 'three'
import {
  ORTHO_RIG,
  applyScrollZoom,
  cameraPosition,
  legacyPoint,
  offsetDirection,
  worldPosition,
} from '@/scene/cameraRig'
import type { Vec3 } from '@/scene/cameraRig'
import { clamp } from '@/core/geometry'
import { sectorPixelHeight, sectorPixelWidth } from '@/core/sector'
import type { Sector } from '@/core/sector'
import { floorPixelAtScreen } from './picking'
import type { ScreenPoint, ViewportSize } from './picking'

/**
 * The editor's camera: the whole-sector fit, the player-parity opening zoom, and the
 * pan/zoom/custom-framing state machine.
 */

/** One camera framing (focus point + orthographic scale) shared by render and picking. */
export interface EditorFraming {
  focus: Vec3
  scale: number
}

/** Play-field height `defaultScale` is tuned against — the player's fixed 640x480 viewport. */
export const PLAYER_VIEWPORT_HEIGHT = 480

/**
 * The orthographic scale that reproduces the player's default close-up magnification in a
 * viewport of the given height, so the editor opens a sector looking exactly as zoomed as the
 * game renders it. Viewport-height dependent — this is why the opening scale is not the
 * whole-sector fit.
 */
export function playerZoomScale(viewportHeight: number): number {
  if (viewportHeight <= 0) return ORTHO_RIG.defaultScale
  return (ORTHO_RIG.defaultScale * viewportHeight) / PLAYER_VIEWPORT_HEIGHT
}

/**
 * Legacy-pixel bounding rect of the sector floor plus every authored object footprint, so
 * props at negative/overflow coordinates stay framed and selectable.
 */
export function fitPixelBounds(sector: Sector): {
  min: { x: number; y: number }
  max: { x: number; y: number }
} {
  const bounds = {
    min: { x: 0, y: 0 },
    max: { x: sectorPixelWidth(sector), y: sectorPixelHeight(sector) },
  }
  for (const object of sector.objects) {
    bounds.min.x = Math.min(bounds.min.x, object.x)
    bounds.min.y = Math.min(bounds.min.y, object.y)
    bounds.max.x = Math.max(bounds.max.x, object.x + object.sourceWidth)
    bounds.max.y = Math.max(bounds.max.y, object.y + object.sourceHeight)
  }
  return bounds
}

/** Camera-plane basis for the fixed pitch + yaw: `right` and `up` span the view plane. */
function cameraBasis(): { right: Vec3; up: Vec3 } {
  const zAxis = offsetDirection()
  const up = { x: 0, y: 1, z: 0 }
  const right = normalized(cross(up, zAxis))
  return { right, up: cross(zAxis, right) }
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }
}

function normalized(vector: Vec3): Vec3 {
  const length = Math.hypot(vector.x, vector.y, vector.z)
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length }
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

/**
 * Framing that fits a legacy-pixel bounding rect into the viewport. The rect lies on the
 * floor plane, where the camera-plane projection is linear in pixel coordinates, so the
 * projected extremes land on the rect corners and the projected center is the rect center.
 *
 * The fit scale is deliberately NOT routed through `clampedScale`/`scaleForZoomFactor`:
 * those bound interactive play zoom, and a whole-sector fit for even a 12x12 sector exceeds
 * `maxScale` under the tilted camera — clamping would crop it.
 */
export function editorFramingFittingPixelBounds(
  minPixel: { x: number; y: number },
  maxPixel: { x: number; y: number },
  viewport: ViewportSize
): EditorFraming {
  const basis = cameraBasis()
  const corners = [
    worldPosition(minPixel.x, minPixel.y),
    worldPosition(maxPixel.x, minPixel.y),
    worldPosition(minPixel.x, maxPixel.y),
    worldPosition(maxPixel.x, maxPixel.y),
  ]
  const horizontal = corners.map((corner) => dot(corner, basis.right))
  const vertical = corners.map((corner) => dot(corner, basis.up))
  const horizontalExtent = Math.max(...horizontal) - Math.min(...horizontal)
  const verticalExtent = Math.max(...vertical) - Math.min(...vertical)
  const focus = worldPosition((minPixel.x + maxPixel.x) / 2, (minPixel.y + maxPixel.y) / 2)
  if (viewport.width <= 0 || viewport.height <= 0) {
    return { focus, scale: ORTHO_RIG.defaultScale }
  }
  const aspect = viewport.width / viewport.height
  // Halved because `scale` is the view volume's vertical half-height.
  const fit = Math.max(verticalExtent, horizontalExtent / aspect) / 2
  return { focus, scale: fit > 0 ? fit : ORTHO_RIG.defaultScale }
}

/** Framing that fits the whole sector — floor rect plus authored footprints — into the viewport. */
export function editorFramingFitting(sector: Sector, viewport: ViewportSize): EditorFraming {
  const bounds = fitPixelBounds(sector)
  return editorFramingFittingPixelBounds(bounds.min, bounds.max, viewport)
}

/** Navigation action a canvas scroll event resolves to; deltas are in AppKit convention. */
export type ScrollIntent =
  { kind: 'zoom'; deltaY: number } | { kind: 'pan'; delta: { width: number; height: number } }

/**
 * Wheel-to-intent mapping: ⌘ routes to zoom with raw deltas (they feed the
 * game's own zoom, whose gain is tuned against raw deltas), a non-precise wheel's pan deltas
 * scale x10 so one tick moves a readable distance, and Shift turns a purely vertical delta
 * horizontal. `hasPreciseDeltas` maps onto `WheelEvent.deltaMode === 0` and `commandHeld`
 * onto `metaKey || ctrlKey` at the shell boundary.
 */
export function scrollIntent(input: {
  deltaX: number
  deltaY: number
  hasPreciseDeltas: boolean
  commandHeld: boolean
  shiftHeld: boolean
}): ScrollIntent {
  if (input.commandHeld) return { kind: 'zoom', deltaY: input.deltaY }
  const lineScale = input.hasPreciseDeltas ? 1 : 10
  let delta = { width: input.deltaX * lineScale, height: input.deltaY * lineScale }
  if (input.shiftHeld && delta.width === 0) {
    delta = { width: delta.height, height: 0 }
  }
  return { kind: 'pan', delta }
}

/**
 * The editor's camera state machine: opens sector-centered at the player's zoom, pans and
 * zooms with the game's own mechanics, and —
 * once the user navigates — preserves the custom camera through document mutations and
 * viewport resizes (`hasCustomFraming`), only re-clamping the focus.
 *
 * Owns writing the framing into the live `THREE.OrthographicCamera`, which is the single
 * source both the renderer draws with and `picking` unprojects through.
 */
export class EditorCamera {
  framing: EditorFraming = { focus: { x: 0, y: 0, z: 0 }, scale: ORTHO_RIG.defaultScale }
  viewportSize: ViewportSize = { width: 640, height: 480 }

  private readonly camera: THREE.OrthographicCamera
  private hasCustomFraming = false
  /** The game's interactive zoom factor, reused verbatim (clamped 0.5x-2x, multiplicative). */
  private zoomFactor = 1

  constructor(camera: THREE.OrthographicCamera) {
    this.camera = camera
    this.apply()
  }

  /**
   * Re-fits (or re-clamps) after a document change. The opening scale is `playerZoomScale`
   * over the current zoom factor — NOT the whole-sector fit, whose focus alone is used.
   */
  refreshFraming(sector: Sector): void {
    if (this.hasCustomFraming) {
      this.applyCustomFraming(this.framing, sector)
      return
    }
    const fit = editorFramingFitting(sector, this.viewportSize)
    this.framing = { focus: fit.focus, scale: playerZoomScale(this.viewportSize.height) / this.zoomFactor }
    this.apply()
  }

  updateViewportSize(size: ViewportSize, sector: Sector): void {
    if (size.width <= 0 || size.height <= 0) return
    if (size.width === this.viewportSize.width && size.height === this.viewportSize.height) return
    this.viewportSize = size
    this.refreshFraming(sector)
  }

  /**
   * Pans by a scroll delta in viewport points: content follows the scroll, so the focus moves
   * to where the shifted viewport center lands on the floor, clamped to the fit extent.
   */
  pan(delta: { width: number; height: number }, sector: Sector): void {
    const shifted: ScreenPoint = {
      x: this.viewportSize.width / 2 - delta.width,
      y: this.viewportSize.height / 2 - delta.height,
    }
    const pixel = floorPixelAtScreen(this.camera, this.viewportSize, shifted)
    this.hasCustomFraming = true
    this.applyCustomFraming({ focus: worldPosition(pixel.x, pixel.y), scale: this.framing.scale }, sector)
  }

  /**
   * ⌘-scroll zoom through the game's clamped multiplicative factor over the player-parity
   * framing for this canvas height — composed from `applyScrollZoom` over `playerZoomScale`,
   * not from `scaleForZoomFactor`, which divides the fixed default scale instead.
   */
  zoom(nativeScaleDeltaY: number, sector: Sector): void {
    this.hasCustomFraming = true
    this.zoomFactor = applyScrollZoom(this.zoomFactor, nativeScaleDeltaY)
    this.applyCustomFraming(
      { focus: this.framing.focus, scale: playerZoomScale(this.viewportSize.height) / this.zoomFactor },
      sector
    )
  }

  /**
   * Legacy pixels covered by one viewport point at the live framing — sizes the resize and
   * facing handles so they keep a constant screen extent across zoom levels.
   */
  legacyPixelsPerViewportPoint(): number {
    if (this.viewportSize.height <= 0) return 1
    return (this.framing.scale * 2) / this.viewportSize.height / ORTHO_RIG.worldUnitsPerPixel
  }

  /** Clamps the focus onto the sector's fit extent (no panning off into the void) and applies. */
  private applyCustomFraming(proposed: EditorFraming, sector: Sector): void {
    const bounds = fitPixelBounds(sector)
    const focusPixel = legacyPoint(proposed.focus)
    const clamped = {
      x: clamp(focusPixel.x, bounds.min.x, bounds.max.x),
      y: clamp(focusPixel.y, bounds.min.y, bounds.max.y),
    }
    this.framing = { focus: worldPosition(clamped.x, clamped.y), scale: proposed.scale }
    this.apply()
  }

  private apply(): void {
    applyFramingToCamera(this.camera, this.framing, this.viewportSize)
  }
}

/**
 * Writes a framing into a camera: the frustum from the raw (unclamped) scale, the position
 * and orientation from the focus. `updateMatrixWorld` runs here rather than waiting for the
 * next render, because picking unprojects through these matrices between frames.
 */
export function applyFramingToCamera(
  camera: THREE.OrthographicCamera,
  framing: EditorFraming,
  viewport: ViewportSize
): void {
  const aspect = viewport.width / viewport.height
  camera.left = -framing.scale * aspect
  camera.right = framing.scale * aspect
  camera.top = framing.scale
  camera.bottom = -framing.scale
  camera.updateProjectionMatrix()
  const position = cameraPosition(framing.focus)
  camera.position.set(position.x, position.y, position.z)
  camera.lookAt(framing.focus.x, framing.focus.y, framing.focus.z)
  camera.updateMatrixWorld(true)
}
