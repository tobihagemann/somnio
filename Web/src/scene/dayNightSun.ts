import { FLOAT_PI, f32 } from '@/core/float'
import type { LightSetting } from '@/core/sector'

/**
 * Mirror of `DayNightAmbient` (SomnioCore) and `DayNightSun` (SomnioScene3D). The ambient
 * staircase is owned once in Swift and consumed by both render paths so the curve cannot drift;
 * this port has to match it for the same reason.
 *
 * `DayNightSun.swift` is `Float` end to end — the constants, the staircase it instantiates, the
 * elevation and warmth, `simd_mix`, and `normalize` — so every step here narrows, per
 * `core/float.ts`'s rule. That is not cosmetic in this file: `southwardLean`, the two indoor
 * scales, and the horizon colour's 0.72 are none of them representable in binary32, so leaving
 * them as doubles shifts the sun's direction, both indoor intensities, and every warm tint away
 * from what the native client renders.
 *
 * Two steps stay in binary64 deliberately, both because they are exact there: Swift's `minute / 12`
 * is *integer* division (see `outdoorAmbient`), and the day-arc divisor `dayEndHour - dayStartHour`
 * is the small integer 16. An `f32` around either would be noise rather than parity, the same
 * judgement `worldMovement` in `cameraRig.ts` records for its double-precision original.
 */

export const DAY_NIGHT = {
  fullSunIntensity: 6000,
  fullAmbientIntensity: 1200,
  dayStartHour: 6,
  dayEndHour: 22,
  /** `65 * .pi / 180` as Swift evaluates it: `Float.pi`, multiplied, then divided. */
  maximumElevationRadians: f32(f32(65 * FLOAT_PI) / 180),
  /** Southward lean so midday shadows fall visibly under the 3/4 camera. */
  southwardLean: f32(0.35),
  indoorAmbientScale: f32(0.65),
  indoorSunScale: f32(0.8),
} as const

/**
 * Uniform fill standing in for the environment lighting `RealityView` supplies by default.
 *
 * This has no counterpart in `DayNightSun` because the native client never had to ask for it:
 * RealityKit lights every scene with a default environment, and `WorldScene3D`'s black backdrop
 * plane hides that environment from view without removing it from the shading. A three.js scene
 * has no such default, so porting only the sun and the fill leaves every surface facing away from
 * both — the camera-facing side of every bookshelf, wall, and prop — lit by nothing at all.
 *
 * Constant rather than scaled by the sector's light level, because RealityKit's default
 * environment is a fixed resource that the world clock does not dim either.
 *
 * The value is calibrated, not derived: with it, the luminance distribution of the rendered world
 * tracks a native capture of the same sector to within a few levels at every decile, where the
 * unlit tenth percentile was previously less than half the native's.
 */
export const ENVIRONMENT_FILL_INTENSITY = 2

/**
 * The sun's shadow volume, mirroring `WorldScene3D.sunShadow` and `repositionSun`.
 *
 * A directional light has no position, but its *shadow* camera does, and fitting that camera to
 * the view frustum produces no shadow at all under an orthographic gameplay camera — the same
 * failure `.automatic` hit natively. So the volume is a fixed box carried along with the camera
 * focus instead.
 *
 * `anchorSnap` is what keeps it from swimming: the focus moves a fraction of a pixel per frame as
 * the player walks, and an unsnapped shadow camera re-rasterizes the map every frame, which reads
 * as every shadow edge crawling.
 */
export const SUN_SHADOW = {
  near: 1,
  far: 60,
  /** Half-extent, matching RealityKit's `orthographicScale`. */
  orthographicScale: 24,
  /** Distance the light is placed back along its own direction from the focus. */
  distance: 30,
  mapSize: 2048,
  /**
   * Offsets the depth comparison along the surface normal rather than the light direction, so
   * near-grazing surfaces (every wall under a near-overhead sun) do not self-shadow into stripes.
   */
  normalBias: 0.02,
} as const

/**
 * The three `SIMD3<Float>` tints. Narrowed because `simd_mix` interpolates between them in `Float`
 * and because they are handed to the light as-is: 0.72, 0.7, and 0.8 are all inexact in binary32, so
 * a double here is a visible-precision difference in the *un-mixed* night colour too.
 */
export const SUN_COLORS = {
  daylight: { r: 1, g: 1, b: 1 },
  horizon: { r: 1, g: f32(0.72), b: 0.5 },
  night: { r: f32(0.7), g: f32(0.8), b: 1 },
} as const

export interface SunState {
  /** Unit direction from the scene toward the light. */
  direction: { x: number; y: number; z: number }
  sunIntensity: number
  sunColor: { r: number; g: number; b: number }
  ambientIntensity: number
}

/**
 * The raw legacy staircase on the 0-100 scale.
 *
 * `minute / 12` is **integer** division in Swift, producing five discrete buckets across the
 * hour rather than a continuous ramp. Using a float divide here would smooth the step and drift
 * from the native client's tint.
 */
export function outdoorAmbient(hour: number, minute: number, brightness: number): number {
  const perMinuteStep = f32(Math.trunc(minute / 12) * f32(brightness / 20))
  if (hour >= 22 || hour <= 5) return 1
  if (hour <= 9) return f32(brighteningAmbient(hour, brightness) + perMinuteStep)
  if (hour <= 17) return f32(brightness)
  return f32(dimmingAmbient(hour, brightness) - perMinuteStep)
}

/** The raw staircase pulled a quarter of the way toward full, so night floors dim not black. */
export function smoothedOutdoorAmbient(hour: number, minute: number, brightness: number): number {
  return f32(100 - f32(f32(100 - outdoorAmbient(hour, minute, brightness)) * 0.75))
}

function brighteningAmbient(hour: number, brightness: number): number {
  switch (hour) {
    case 6:
      return 1
    case 7:
      return f32(brightness / 4)
    case 8:
      return f32(brightness / 2)
    case 9:
      return f32(brightness * 0.75)
    default:
      return 1
  }
}

function dimmingAmbient(hour: number, brightness: number): number {
  switch (hour) {
    case 18:
      return f32(brightness)
    case 19:
      return f32(brightness * 0.75)
    case 20:
      return f32(brightness / 2)
    case 21:
      return f32(brightness / 4)
    default:
      return 1
  }
}

/** Fixed key direction for indoor sectors: steeper than any sun, so ceiling lights read right. */
const INDOOR_DIRECTION = normalize({ x: f32(-0.4), y: 1, z: f32(0.28) })
/** The dim outdoor "moon". */
const NIGHT_DIRECTION = normalize({ x: f32(-0.2), y: 1, z: f32(0.3) })

export function sunState(hour: number, minute: number, sectorLight: LightSetting): SunState {
  if (sectorLight.indoor) {
    const level = f32(sectorLight.brightness / 100)
    return {
      direction: INDOOR_DIRECTION,
      // `level * scale * full` associates left to right in Swift too, so the intermediate narrows.
      sunIntensity: f32(f32(level * DAY_NIGHT.indoorSunScale) * DAY_NIGHT.fullSunIntensity),
      sunColor: SUN_COLORS.daylight,
      ambientIntensity: f32(f32(level * DAY_NIGHT.indoorAmbientScale) * DAY_NIGHT.fullAmbientIntensity),
    }
  }

  const level = f32(smoothedOutdoorAmbient(hour, minute, sectorLight.brightness) / 100)
  const time = f32(hour + f32(minute / 60))
  if (time < DAY_NIGHT.dayStartHour || time >= DAY_NIGHT.dayEndHour) {
    return {
      direction: NIGHT_DIRECTION,
      sunIntensity: f32(level * DAY_NIGHT.fullSunIntensity),
      sunColor: SUN_COLORS.night,
      ambientIntensity: f32(level * DAY_NIGHT.fullAmbientIntensity),
    }
  }

  const progress = f32(f32(time - DAY_NIGHT.dayStartHour) / (DAY_NIGHT.dayEndHour - DAY_NIGHT.dayStartHour))
  const arcAngle = f32(progress * FLOAT_PI)
  // `sin`/`cos` on a `Float` argument resolve to `sinf`/`cosf` in Swift; JavaScript has only the
  // binary64 pair, so the result is narrowed — the same accommodation `atan2F32` documents. Parity is
  // exact for the algebraic chain around these calls, not for libm's own last bit.
  const elevation = f32(DAY_NIGHT.maximumElevationRadians * f32(Math.sin(arcAngle)))
  // The sun rises east (+X), arcs through the leaning south, and sets west (-X).
  const horizontal = normalize({ x: f32(Math.cos(arcAngle)), y: 0, z: DAY_NIGHT.southwardLean })
  const elevationCosine = f32(Math.cos(elevation))
  const warmth = f32(elevation / DAY_NIGHT.maximumElevationRadians)
  return {
    direction: {
      x: f32(horizontal.x * elevationCosine),
      y: f32(Math.sin(elevation)),
      z: f32(horizontal.z * elevationCosine),
    },
    sunIntensity: f32(level * DAY_NIGHT.fullSunIntensity),
    sunColor: mixColor(SUN_COLORS.horizon, SUN_COLORS.daylight, warmth),
    ambientIntensity: f32(level * DAY_NIGHT.fullAmbientIntensity),
  }
}

/**
 * `simd`'s `normalize` on a `SIMD3<Float>`: each component over `sqrt(dot(v, v))`, computed in
 * `Float`.
 *
 * Spelled out as a narrowed dot product rather than `Math.hypot`. Hypot is not the same function —
 * it is a scaling algorithm chosen to avoid intermediate overflow, so it returns a different last
 * bit than a plain `sqrt` of the sum of squares, and the length divides three components. Sitting a
 * binary64 length under three narrowed divides, which is what this used to do, narrows the wrong
 * step: the extra mantissa bits are in the divisor.
 */
function normalize(vector: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const dot = f32(f32(f32(vector.x * vector.x) + f32(vector.y * vector.y)) + f32(vector.z * vector.z))
  const length = f32(Math.sqrt(dot))
  return { x: f32(vector.x / length), y: f32(vector.y / length), z: f32(vector.z / length) }
}

/** `simd_mix(from, to, t)` — `from + (to - from) * t` per component, in `Float`. */
function mixColor(
  from: { r: number; g: number; b: number },
  to: { r: number; g: number; b: number },
  amount: number
): { r: number; g: number; b: number } {
  return {
    r: f32(from.r + f32(f32(to.r - from.r) * amount)),
    g: f32(from.g + f32(f32(to.g - from.g) * amount)),
    b: f32(from.b + f32(f32(to.b - from.b) * amount)),
  }
}
