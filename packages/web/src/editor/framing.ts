import type * as THREE from 'three';
import { ORTHO_RIG, applyScrollZoom, cameraPosition, offsetDirection } from '@/scene/cameraRig';
import type { Vec3 } from '@/scene/cameraRig';
import { clamp, sectorPointInSpace, sectorRect } from '@somnio/core';
import type { Point, Sector } from '@somnio/core';
import { floorPointAtScreen } from './picking';
import type { ScreenPoint, ViewportSize } from './picking';

/**
 * The editor's camera: the whole-sector fit, the player-parity opening zoom, and the
 * pan/zoom/custom-framing state machine.
 */

/** One camera framing (focus point + orthographic scale) shared by render and picking. */
export interface EditorFraming {
  focus: Vec3;
  scale: number;
}

/** The viewport height at which the editor's opening scale is the game's `defaultScale`. */
const PLAYER_VIEWPORT_HEIGHT = 480;

/**
 * The orthographic scale the editor opens a sector at: the game's default close-up at
 * `PLAYER_VIEWPORT_HEIGHT`, growing with the viewport so a metre keeps its size on screen and a
 * taller canvas shows more ground. Viewport-height dependent — this is why the opening scale is
 * not the whole-sector fit.
 */
export function playerZoomScale(viewportHeight: number): number {
  if (viewportHeight <= 0) return ORTHO_RIG.defaultScale;
  return (ORTHO_RIG.defaultScale * viewportHeight) / PLAYER_VIEWPORT_HEIGHT;
}

/**
 * Bounding rect, in space coordinates, of the sector floor plus every placement's position, so
 * props standing past the sector's edge stay framed and selectable.
 */
export function fitBounds(sector: Sector): { min: Point; max: Point } {
  const rect = sectorRect(sector);
  const bounds = {
    min: { x: rect.x, z: rect.z },
    max: { x: rect.x + rect.width, z: rect.z + rect.depth },
  };
  for (const placement of sector.placements) {
    const position = sectorPointInSpace(sector, placement);
    bounds.min.x = Math.min(bounds.min.x, position.x);
    bounds.min.z = Math.min(bounds.min.z, position.z);
    bounds.max.x = Math.max(bounds.max.x, position.x);
    bounds.max.z = Math.max(bounds.max.z, position.z);
  }
  return bounds;
}

/** Camera-plane basis for the fixed pitch + yaw: `right` and `up` span the view plane. */
function cameraBasis(): { right: Vec3; up: Vec3 } {
  const zAxis = offsetDirection();
  const up = { x: 0, y: 1, z: 0 };
  const right = normalized(cross(up, zAxis));
  return { right, up: cross(zAxis, right) };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function normalized(vector: Vec3): Vec3 {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/**
 * Framing that fits a bounding rect on the ground into the viewport. The rect lies on the
 * floor plane, where the camera-plane projection is linear in ground coordinates, so the
 * projected extremes land on the rect corners and the projected center is the rect center.
 *
 * The fit scale is deliberately NOT routed through `clampedScale`/`scaleForZoomFactor`:
 * those bound interactive play zoom, and a whole-sector fit for even a 30 m sector exceeds
 * `maxScale` under the tilted camera — clamping would crop it.
 */
export function editorFramingFittingBounds(min: Point, max: Point, viewport: ViewportSize): EditorFraming {
  const basis = cameraBasis();
  const corners = [
    { x: min.x, y: 0, z: min.z },
    { x: max.x, y: 0, z: min.z },
    { x: min.x, y: 0, z: max.z },
    { x: max.x, y: 0, z: max.z },
  ];
  const horizontal = corners.map((corner) => dot(corner, basis.right));
  const vertical = corners.map((corner) => dot(corner, basis.up));
  const horizontalExtent = Math.max(...horizontal) - Math.min(...horizontal);
  const verticalExtent = Math.max(...vertical) - Math.min(...vertical);
  const focus = { x: (min.x + max.x) / 2, y: 0, z: (min.z + max.z) / 2 };
  if (viewport.width <= 0 || viewport.height <= 0) {
    return { focus, scale: ORTHO_RIG.defaultScale };
  }
  const aspect = viewport.width / viewport.height;
  // Halved because `scale` is the view volume's vertical half-height.
  const fit = Math.max(verticalExtent, horizontalExtent / aspect) / 2;
  return { focus, scale: fit > 0 ? fit : ORTHO_RIG.defaultScale };
}

/** Framing that fits the whole sector — floor rect plus placement positions — into the viewport. */
export function editorFramingFitting(sector: Sector, viewport: ViewportSize): EditorFraming {
  const bounds = fitBounds(sector);
  return editorFramingFittingBounds(bounds.min, bounds.max, viewport);
}

/** Navigation action a canvas scroll event resolves to; deltas are positive for scroll-up. */
export type ScrollIntent = { kind: 'zoom'; deltaY: number } | { kind: 'pan'; delta: { width: number; height: number } };

/**
 * Wheel-to-intent mapping: ⌘ routes to zoom with raw deltas (they feed the
 * game's own zoom, whose gain is tuned against raw deltas), a non-precise wheel's pan deltas
 * scale x10 so one tick moves a readable distance, and Shift turns a purely vertical delta
 * horizontal. `hasPreciseDeltas` maps onto `WheelEvent.deltaMode === 0` and `commandHeld`
 * onto `metaKey || ctrlKey` at the shell boundary.
 */
export function scrollIntent(input: { deltaX: number; deltaY: number; hasPreciseDeltas: boolean; commandHeld: boolean; shiftHeld: boolean }): ScrollIntent {
  if (input.commandHeld) return { kind: 'zoom', deltaY: input.deltaY };
  const lineScale = input.hasPreciseDeltas ? 1 : 10;
  let delta = { width: input.deltaX * lineScale, height: input.deltaY * lineScale };
  if (input.shiftHeld && delta.width === 0) {
    delta = { width: delta.height, height: 0 };
  }
  return { kind: 'pan', delta };
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
  framing: EditorFraming = { focus: { x: 0, y: 0, z: 0 }, scale: ORTHO_RIG.defaultScale };
  viewportSize: ViewportSize = { width: 640, height: 480 };

  private readonly camera: THREE.OrthographicCamera;
  private readonly onFocused: (focus: Vec3) => void;
  private hasCustomFraming = false;
  /** The game's interactive zoom factor, reused verbatim (clamped 0.5x-2x, multiplicative). */
  private zoomFactor = 1;

  /** `onFocused` hears every focus the framing lands on, so what follows the view (the sun's shadow volume) can follow it. */
  constructor(camera: THREE.OrthographicCamera, onFocused: (focus: Vec3) => void = () => {}) {
    this.camera = camera;
    this.onFocused = onFocused;
    this.apply();
  }

  /**
   * Re-fits (or re-clamps) after a document change. The opening scale is `playerZoomScale`
   * over the current zoom factor — NOT the whole-sector fit, whose focus alone is used.
   */
  refreshFraming(sector: Sector): void {
    if (this.hasCustomFraming) {
      this.applyCustomFraming(this.framing, sector);
      return;
    }
    const fit = editorFramingFitting(sector, this.viewportSize);
    this.framing = { focus: fit.focus, scale: playerZoomScale(this.viewportSize.height) / this.zoomFactor };
    this.apply();
  }

  updateViewportSize(size: ViewportSize, sector: Sector): void {
    if (size.width <= 0 || size.height <= 0) return;
    if (size.width === this.viewportSize.width && size.height === this.viewportSize.height) return;
    this.viewportSize = size;
    this.refreshFraming(sector);
  }

  /**
   * Pans by a scroll delta in viewport points: content follows the scroll, so the focus moves
   * to where the shifted viewport center lands on the floor, clamped to the fit extent.
   */
  pan(delta: { width: number; height: number }, sector: Sector): void {
    const shifted: ScreenPoint = {
      x: this.viewportSize.width / 2 - delta.width,
      y: this.viewportSize.height / 2 - delta.height,
    };
    const point = floorPointAtScreen(this.camera, this.viewportSize, shifted);
    this.hasCustomFraming = true;
    this.applyCustomFraming({ focus: { x: point.x, y: 0, z: point.z }, scale: this.framing.scale }, sector);
  }

  /**
   * ⌘-scroll zoom through the game's clamped multiplicative factor over the player-parity
   * framing for this canvas height — composed from `applyScrollZoom` over `playerZoomScale`,
   * not from `scaleForZoomFactor`, which divides the fixed default scale instead.
   */
  zoom(zoomDeltaY: number, sector: Sector): void {
    this.hasCustomFraming = true;
    this.zoomFactor = applyScrollZoom(this.zoomFactor, zoomDeltaY);
    this.applyCustomFraming({ focus: this.framing.focus, scale: playerZoomScale(this.viewportSize.height) / this.zoomFactor }, sector);
  }

  /** Clamps the focus onto the sector's fit extent (no panning off into the void) and applies. */
  private applyCustomFraming(proposed: EditorFraming, sector: Sector): void {
    const bounds = fitBounds(sector);
    const focus = {
      x: clamp(proposed.focus.x, bounds.min.x, bounds.max.x),
      y: 0,
      z: clamp(proposed.focus.z, bounds.min.z, bounds.max.z),
    };
    this.framing = { focus, scale: proposed.scale };
    this.apply();
  }

  private apply(): void {
    applyFramingToCamera(this.camera, this.framing, this.viewportSize);
    this.onFocused(this.framing.focus);
  }
}

/**
 * Writes a framing into a camera: the frustum from the raw (unclamped) scale, the position
 * and orientation from the focus. `updateMatrixWorld` runs here rather than waiting for the
 * next render, because picking unprojects through these matrices between frames.
 */
export function applyFramingToCamera(camera: THREE.OrthographicCamera, framing: EditorFraming, viewport: ViewportSize): void {
  const aspect = viewport.width / viewport.height;
  camera.left = -framing.scale * aspect;
  camera.right = framing.scale * aspect;
  camera.top = framing.scale;
  camera.bottom = -framing.scale;
  camera.updateProjectionMatrix();
  const position = cameraPosition(framing.focus);
  camera.position.set(position.x, position.y, position.z);
  camera.lookAt(framing.focus.x, framing.focus.y, framing.focus.z);
  camera.updateMatrixWorld(true);
}
