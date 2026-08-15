import { FLOAT_PI, f32 } from '@/core/float'
import { clamp } from '@/core/geometry'

/**
 * Mirror of `Sources/SomnioScene3D/OrthographicCameraRig.swift` — pure placement math for the
 * fixed 3/4 orthographic camera, kept free of Three.js so it stays unit-testable.
 */

export const ORTHO_RIG = {
  pitchDegrees: 45,
  yawDegrees: 35,
  /** Pure translation under an orthographic projection; only has to clear the near plane. */
  cameraDistance: 50,
  defaultScale: 3,
  maxScale: 24,
  nearClip: 0.05,
  farClip: 500,
  /**
   * World units per legacy pixel — the pixel grid stays authoritative.
   *
   * Narrowed because Swift declares it `Float` (`OrthographicCameraRig.swift`) and `core/float.ts`'s
   * rule is that every step Swift performs in `Float` gets an `f32` here. A binary64 `0.02` carries
   * extra mantissa bits into the multiply, so `f32(pixel) * 0.02` lands a few ULPs off Swift's
   * `Float(pixel) * Float(0.02)` even after narrowing the result.
   */
  worldUnitsPerPixel: f32(0.02),
} as const

export const PLAYER_ZOOM = { minFactor: 0.5, maxFactor: 2.0, scrollGain: 0.015 } as const

/** Derived so the rig bound and the zoom clamp agree by construction. */
export const MIN_SCALE = ORTHO_RIG.defaultScale / PLAYER_ZOOM.maxFactor

export function clampedScale(scale: number): number {
  return clamp(scale, MIN_SCALE, ORTHO_RIG.maxScale)
}

export interface Vec3 {
  x: number
  y: number
  z: number
}

/**
 * Orthographic frustum bounds for a viewport.
 *
 * **`scale` is the vertical HALF-height**, not the full extent: the render spans `2 x scale`
 * metres vertically. This is settled in-repo — `EditorCameraFraming.swift` records that treating
 * it as full height "made every unprojection overshoot the drawn geometry by exactly 2x from the
 * view centre — measured against the live render", and the editor's picking math depends on it.
 *
 * Consequently this is **not** Three.js's usual `frustumSize / 2` idiom. Applying that idiom to a
 * value that is already a half-height halves it again, and the whole world renders at 2x
 * magnification — which looks plausible until you put it side by side with the native client.
 */
export function frustumBounds(
  scale: number,
  aspect: number
): { left: number; right: number; top: number; bottom: number } {
  return { left: -scale * aspect, right: scale * aspect, top: scale, bottom: -scale }
}

/**
 * Maps a legacy top-left pixel coordinate onto the floor plane (Y = 0): X runs east, the legacy
 * Y-down axis runs along +Z, into the scene under the 3/4 camera.
 */
export function worldPosition(pixelX: number, pixelY: number): Vec3 {
  return {
    x: f32(f32(pixelX) * ORTHO_RIG.worldUnitsPerPixel),
    y: 0,
    z: f32(f32(pixelY) * ORTHO_RIG.worldUnitsPerPixel),
  }
}

/** Inverse of `worldPosition`, keeping the pixel-to-world axis mapping inside the rig. */
export function legacyPoint(position: Vec3): { x: number; y: number } {
  return {
    x: f32(position.x / ORTHO_RIG.worldUnitsPerPixel),
    y: f32(position.z / ORTHO_RIG.worldUnitsPerPixel),
  }
}

/**
 * Rotates a screen-space movement vector (x right, y down) into legacy floor axes, so "up" on
 * the yawed camera walks away from the viewer instead of drifting along world north. Pure
 * rotation, so a unit input stays unit length.
 *
 * Computed in double precision because the Swift original is: `dx`/`dy` are `Double` there, so
 * this is one of the few rig functions with no narrowing.
 */
export function worldMovement(screenDX: number, screenDY: number): { dx: number; dy: number } {
  const yaw = (ORTHO_RIG.yawDegrees * Math.PI) / 180
  return {
    dx: screenDX * Math.cos(yaw) + screenDY * Math.sin(yaw),
    dy: -screenDX * Math.sin(yaw) + screenDY * Math.cos(yaw),
  }
}

/** Unit direction from the focus point toward the camera, from the fixed pitch and yaw. */
export function offsetDirection(): Vec3 {
  const pitch = f32(f32(ORTHO_RIG.pitchDegrees * FLOAT_PI) / 180)
  const yaw = f32(f32(ORTHO_RIG.yawDegrees * FLOAT_PI) / 180)
  return {
    x: f32(f32(Math.cos(pitch)) * f32(Math.sin(yaw))),
    y: f32(Math.sin(pitch)),
    z: f32(f32(Math.cos(pitch)) * f32(Math.cos(yaw))),
  }
}

export function cameraPosition(focus: Vec3): Vec3 {
  const direction = offsetDirection()
  return {
    x: f32(focus.x + f32(direction.x * ORTHO_RIG.cameraDistance)),
    y: f32(focus.y + f32(direction.y * ORTHO_RIG.cameraDistance)),
    z: f32(focus.z + f32(direction.z * ORTHO_RIG.cameraDistance)),
  }
}

/**
 * DOM wheel deltas into the units `PLAYER_ZOOM.scrollGain` is tuned for.
 *
 * The gain mirrors `PlayerZoom.scrollGain`, which is fed `NSEvent.scrollingDeltaY` — a few units per
 * mouse-wheel notch. Chrome and Safari on macOS report ~100 px for the same notch, and
 * `exp(100 * 0.015)` is 4.5x: more than the entire 0.5-2.0 range, so one notch would pin the camera
 * at a stop with no steps in between. Both the sign and the scale therefore have to be converted,
 * not just the sign.
 *
 * Deliberately proportional rather than quantized to whole notches: a trackpad reports a stream of
 * small pixel deltas, and dividing by the same constant keeps it continuous instead of stair-stepping.
 */
export const WHEEL_NOTCH = {
  /** DOM_DELTA_PIXEL: one notch in Chrome/Safari on macOS. */
  pixels: 100,
  /** DOM_DELTA_LINE, which Firefox reports. */
  lines: 3,
  /** DOM_DELTA_PAGE. */
  pages: 1,
  /**
   * `scrollingDeltaY` equivalent for one notch. Sized so a notch moves the factor ~5.9%, about 24
   * notches across the range — the granularity the native wheel gives at its own delta scale.
   */
  nativeDelta: 3.85,
} as const

export function wheelDeltaToNativeScale(deltaY: number, deltaMode: number): number {
  const perNotch =
    deltaMode === 1 ? WHEEL_NOTCH.lines : deltaMode === 2 ? WHEEL_NOTCH.pages : WHEEL_NOTCH.pixels
  return (deltaY / perNotch) * WHEEL_NOTCH.nativeDelta
}

/**
 * Session-only scroll zoom. Multiplicative steps keep the feel uniform across the range — one wheel
 * tick moves the same *fraction* at either clamp end.
 */
export function applyScrollZoom(factor: number, deltaY: number): number {
  return clamp(
    factor * Math.exp(deltaY * PLAYER_ZOOM.scrollGain),
    PLAYER_ZOOM.minFactor,
    PLAYER_ZOOM.maxFactor
  )
}

/** The camera scale for a zoom factor: larger factor means more magnified, so smaller scale. */
export function scaleForZoomFactor(zoomFactor: number): number {
  return clampedScale(ORTHO_RIG.defaultScale / zoomFactor)
}
