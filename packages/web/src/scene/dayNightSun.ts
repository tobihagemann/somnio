/**
 * The day/night light: the outdoor ambient ramp and the sun.
 */
import { worldMovement } from './cameraRig';

const DAY_NIGHT = {
  fullSunIntensity: 6000,
  fullAmbientIntensity: 1200,
  dayStartHour: 6,
  dayEndHour: 22,
  maximumElevationRadians: (65 * Math.PI) / 180,
  /**
   * How far the arc leans toward the camera's left, against an east-west swing of 1. The camera
   * hides the ground behind a caster for as far as the caster is tall, so a high sun on the
   * camera's own side throws every shadow into exactly that strip: cast, and never seen.
   */
  lean: 1,
  indoorAmbientScale: 0.65,
  indoorSunScale: 0.8,
  /** How long, in hours, the sun takes to fade out before a day/night switch and back in after it. */
  twilightHours: 0.5,
} as const;

/**
 * Uniform fill standing in for a default environment light.
 *
 * A three.js scene has no default environment, so the sun and the directional fill alone leave
 * every surface facing away from both — the camera-facing side of every bookshelf, wall, and
 * prop — lit by nothing at all.
 *
 * Constant rather than scaled by the sector's light level: it stands in for a fixed resource that
 * the world clock does not dim.
 *
 * The value is calibrated, not derived: with it, the luminance distribution of the rendered world
 * tracks the reference capture of the same sector to within a few levels at every decile; without
 * it the unlit tenth percentile is less than half the reference's.
 */
export const ENVIRONMENT_FILL_INTENSITY = 2;

/**
 * The sun's shadow volume.
 *
 * A directional light has no position, but its *shadow* camera does, and fitting that camera to
 * the view frustum produces no shadow at all under an orthographic gameplay camera. So the volume
 * is a fixed box carried along with the camera focus instead.
 *
 * `anchorSnap` is what keeps it from swimming: the focus moves a fraction of a pixel per frame as
 * the player walks, and an unsnapped shadow camera re-rasterizes the map every frame, which reads
 * as every shadow edge crawling.
 */
export const SUN_SHADOW = {
  near: 1,
  far: 60,
  /** Half-extent of the shadow camera. */
  orthographicScale: 24,
  /** Distance the light is placed back along its own direction from the focus. */
  distance: 30,
  mapSize: 2048,
  /**
   * Offsets the depth comparison along the surface normal rather than the light direction, so
   * near-grazing surfaces (every wall under a near-overhead sun) do not self-shadow into stripes.
   */
  normalBias: 0.02,
} as const;

const SUN_COLORS = {
  daylight: { r: 1, g: 1, b: 1 },
  horizon: { r: 1, g: 0.72, b: 0.5 },
  night: { r: 0.7, g: 0.8, b: 1 },
} as const;

export interface SunState {
  /** Unit direction from the scene toward the light. */
  direction: { x: number; y: number; z: number };
  sunIntensity: number;
  sunColor: { r: number; g: number; b: number };
  ambientIntensity: number;
}

/**
 * Outdoor ambient by hour, in percent: dark through the night, rising through the morning, full
 * across the day, and falling through the evening. The light is interpolated linearly between
 * these anchors.
 */
const OUTDOOR_AMBIENT_ANCHORS: readonly (readonly [hour: number, percent: number])[] = [
  [0, 1],
  [6, 1],
  [7, 25],
  [8, 50],
  [9, 75],
  [10, 100],
  [18, 100],
  [19, 75],
  [20, 50],
  [21, 25],
  [22, 1],
  [24, 1],
];

/** The ambient level in `[0, 1]`, pulled a quarter of the way toward full so night floors dim, not black. */
function outdoorAmbientLevel(hourOfDay: number): number {
  const next = OUTDOOR_AMBIENT_ANCHORS.findIndex(([hour]) => hour > hourOfDay);
  const [fromHour, from] = OUTDOOR_AMBIENT_ANCHORS[next - 1]!;
  const [toHour, to] = OUTDOOR_AMBIENT_ANCHORS[next]!;
  const percent = from + ((to - from) * (hourOfDay - fromHour)) / (toHour - fromHour);
  return (100 - (100 - percent) * 0.75) / 100;
}

/**
 * How much of the directional light is on: it falls to nothing over the half hour before each
 * day/night switch and rises over the half hour after, so the jump in direction and colour at the
 * switch happens while the light is off. The ambient and fill lights carry the scene across.
 */
function twilightFactor(hourOfDay: number): number {
  const hoursFromSwitch = Math.min(Math.abs(hourOfDay - DAY_NIGHT.dayStartHour), Math.abs(hourOfDay - DAY_NIGHT.dayEndHour));
  return Math.min(1, hoursFromSwitch / DAY_NIGHT.twilightHours);
}

/** Ground direction toward the camera's left, at right angles to the view: the side the interior key stands on. */
const LEAN_DIRECTION = worldMovement(-1, 0);

/** Fixed key direction for interior sectors: steeper than any sun, so ceiling lights read right. */
const INDOOR_DIRECTION = normalize({ x: -0.4, y: 1, z: 0.28 });
/** The dim outdoor "moon". */
const NIGHT_DIRECTION = normalize({ x: -0.2, y: 1, z: 0.3 });

/**
 * The light for a fractional hour of the day in `[0, 24)`. `brightness` is an interior sector's
 * percentage, which fixes the light whatever the hour; `undefined` is outdoors, lit by the clock.
 */
export function sunState(hourOfDay: number, brightness: number | undefined): SunState {
  if (brightness !== undefined) {
    const level = brightness / 100;
    return {
      direction: INDOOR_DIRECTION,
      sunIntensity: level * DAY_NIGHT.indoorSunScale * DAY_NIGHT.fullSunIntensity,
      sunColor: SUN_COLORS.daylight,
      ambientIntensity: level * DAY_NIGHT.indoorAmbientScale * DAY_NIGHT.fullAmbientIntensity,
    };
  }

  const level = outdoorAmbientLevel(hourOfDay);
  const sunIntensity = level * DAY_NIGHT.fullSunIntensity * twilightFactor(hourOfDay);
  const ambientIntensity = level * DAY_NIGHT.fullAmbientIntensity;
  if (hourOfDay < DAY_NIGHT.dayStartHour || hourOfDay >= DAY_NIGHT.dayEndHour) {
    return { direction: NIGHT_DIRECTION, sunIntensity, sunColor: SUN_COLORS.night, ambientIntensity };
  }

  const progress = (hourOfDay - DAY_NIGHT.dayStartHour) / (DAY_NIGHT.dayEndHour - DAY_NIGHT.dayStartHour);
  const arcAngle = progress * Math.PI;
  const elevation = DAY_NIGHT.maximumElevationRadians * Math.sin(arcAngle);
  // The sun rises in the south-south-east, stands at the camera's left when highest, and sets in the
  // west-south-west.
  const horizontal = normalize({ x: Math.cos(arcAngle) + DAY_NIGHT.lean * LEAN_DIRECTION.dx, y: 0, z: DAY_NIGHT.lean * LEAN_DIRECTION.dz });
  const elevationCosine = Math.cos(elevation);
  const warmth = elevation / DAY_NIGHT.maximumElevationRadians;
  return {
    direction: {
      x: horizontal.x * elevationCosine,
      y: Math.sin(elevation),
      z: horizontal.z * elevationCosine,
    },
    sunIntensity,
    sunColor: mixColor(SUN_COLORS.horizon, SUN_COLORS.daylight, warmth),
    ambientIntensity,
  };
}

function normalize(vector: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function mixColor(from: { r: number; g: number; b: number }, to: { r: number; g: number; b: number }, amount: number): { r: number; g: number; b: number } {
  return {
    r: from.r + (to.r - from.r) * amount,
    g: from.g + (to.g - from.g) * amount,
    b: from.b + (to.b - from.b) * amount,
  };
}
