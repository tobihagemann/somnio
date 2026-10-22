/**
 * The day/night light: the sun, the hemisphere fill under the sky, and the backdrop past the
 * world, all read from one table by the hour.
 */
import { worldMovement } from './cameraRig';

const DAY_NIGHT = {
  dayStartHour: 6,
  dayEndHour: 22,
  maximumElevationRadians: (55 * Math.PI) / 180,
  /**
   * How far round the sun's bearing turns from sunrise to sunset, at an even pace, so shadows
   * wheel round their casters all day. It rises behind the camera, where the low sun throws long
   * shadows up the screen, and turns through the camera's left to beyond the far side of the world.
   * That keeps the high sun off the camera's own side: there the camera hides the ground behind a
   * caster for as far as the caster is tall, so a short shadow falls into exactly that strip, cast
   * and never seen.
   */
  sweepRadians: (240 * Math.PI) / 180,
  /** How long, in hours, the sun takes to fade out before a day/night switch and back in after it. */
  twilightHours: 0.5,
} as const;

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

/** A colour in linear RGB, the space three.js lights in. */
interface LinearColor {
  r: number;
  g: number;
  b: number;
}

export interface SunState {
  /** Unit direction from the scene toward the light. */
  direction: { x: number; y: number; z: number };
  /** In three.js units, as the scene applies it. */
  sunIntensity: number;
  sunColor: LinearColor;
  skyColor: LinearColor;
  groundColor: LinearColor;
  hemisphereIntensity: number;
  /** What shows past the edge of the world. */
  backdropColor: LinearColor;
}

/** One row of the light table: what lights the scene at an hour. Colours are sRGB hex, as authored. */
interface LightAnchor {
  sun: number;
  sunColor: number;
  sky: number;
  ground: number;
  hemisphere: number;
  backdrop: number;
}

const NOON: LightAnchor = { sun: 3, sunColor: 0xfff4e0, sky: 0xdce9ff, ground: 0x74654b, hemisphere: 0.9, backdrop: 0x7a8a79 };
const TWILIGHT: LightAnchor = { sun: 1.8, sunColor: 0xffa860, sky: 0xffc9a0, ground: 0x5a4636, hemisphere: 0.7, backdrop: 0x6b5a58 };
/** The moon, bright enough that paths, doors, and nightmares stay readable. */
const NIGHT: LightAnchor = { sun: 0.9, sunColor: 0xa9bcff, sky: 0x5a70b0, ground: 0x2c2c3c, hemisphere: 0.8, backdrop: 0x1b2233 };
/**
 * A room's warm, steady light, whatever the hour; its two intensities scale with the room's
 * brightness. It is dim enough to let the room's own flames show. The backdrop stays near-black,
 * because a voice from a room's door is shown in the dark just past its wall.
 */
const INTERIOR: LightAnchor = { sun: 1.26, sunColor: 0xffdfba, sky: 0xf3dfc6, ground: 0x645143, hemisphere: 0.55, backdrop: 0x24282c };

/** Keys the hour table, so the outdoor light and the light through a room's door each give the day's three lights values of their own. */
type DayLight = 'night' | 'twilight' | 'noon';

/**
 * The hours of the day's lights: night held flat to 5, dawn at 7, full day from 10 to 18, dusk at
 * 19, and night again from 22. Every value is interpolated linearly between neighbouring hours.
 */
const DAY_HOURS: readonly (readonly [hour: number, light: DayLight])[] = [
  [0, 'night'],
  [5, 'night'],
  [7, 'twilight'],
  [10, 'noon'],
  [18, 'noon'],
  [19, 'twilight'],
  [22, 'night'],
  [24, 'night'],
];

const OUTDOOR_LIGHT: Record<DayLight, LightAnchor> = { night: NIGHT, twilight: TWILIGHT, noon: NOON };
const OUTDOOR_ANCHORS = DAY_HOURS.map(([hour, light]) => [hour, OUTDOOR_LIGHT[light]] as const);

/** The light that falls through a room's door: the day's, warm, and a faint cool one at night. */
export interface DoorLightState {
  color: LinearColor;
  /** In three.js units, as the scene applies it. */
  intensity: number;
}

const DOOR_LIGHT: Record<DayLight, { intensity: number; color: number }> = {
  night: { intensity: 2, color: 0x8fa6e0 },
  twilight: { intensity: 6, color: 0xffc9a0 },
  noon: { intensity: 14, color: 0xfff1d6 },
};
const DOOR_ANCHORS = DAY_HOURS.map(([hour, light]) => [hour, DOOR_LIGHT[light]] as const);

/** The light through a room's door at a fractional hour of the day in `[0, 24)`. */
export function doorLightState(hourOfDay: number): DoorLightState {
  const { from, to, amount } = anchorsAround(DOOR_ANCHORS, hourOfDay);
  return { color: mixColor(linearColor(from.color), linearColor(to.color), amount), intensity: mix(from.intensity, to.intensity, amount) };
}

/**
 * How much of the directional light is on: it falls to nothing over the half hour before each
 * day/night switch and rises over the half hour after, so the jump in direction at the switch
 * happens while the light is off. The hemisphere fill carries the scene across.
 */
function twilightFactor(hourOfDay: number): number {
  const hoursFromSwitch = Math.min(Math.abs(hourOfDay - DAY_NIGHT.dayStartHour), Math.abs(hourOfDay - DAY_NIGHT.dayEndHour));
  return Math.min(1, hoursFromSwitch / DAY_NIGHT.twilightHours);
}

/** Ground direction toward the camera, where the sun rises. */
const TOWARD_CAMERA = worldMovement(0, 1);
const SUNRISE_BEARING = Math.atan2(TOWARD_CAMERA.dz, TOWARD_CAMERA.dx);

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
    const light = lightOf(INTERIOR);
    return { ...light, direction: INDOOR_DIRECTION, sunIntensity: level * light.sunIntensity, hemisphereIntensity: level * light.hemisphereIntensity };
  }

  const light = outdoorLight(hourOfDay);
  const sunIntensity = light.sunIntensity * twilightFactor(hourOfDay);
  if (hourOfDay < DAY_NIGHT.dayStartHour || hourOfDay >= DAY_NIGHT.dayEndHour) {
    return { ...light, direction: NIGHT_DIRECTION, sunIntensity };
  }

  const progress = (hourOfDay - DAY_NIGHT.dayStartHour) / (DAY_NIGHT.dayEndHour - DAY_NIGHT.dayStartHour);
  const elevation = DAY_NIGHT.maximumElevationRadians * Math.sin(progress * Math.PI);
  const bearing = SUNRISE_BEARING + progress * DAY_NIGHT.sweepRadians;
  const horizontal = { x: Math.cos(bearing), z: Math.sin(bearing) };
  const elevationCosine = Math.cos(elevation);
  return {
    ...light,
    direction: {
      x: horizontal.x * elevationCosine,
      y: Math.sin(elevation),
      z: horizontal.z * elevationCosine,
    },
    sunIntensity,
  };
}

/** The outdoor table read at an hour, before the sun's fade across the day/night switch. */
function outdoorLight(hourOfDay: number): Omit<SunState, 'direction'> {
  const { from, to, amount } = anchorsAround(OUTDOOR_ANCHORS, hourOfDay);
  const start = lightOf(from);
  const end = lightOf(to);
  return {
    sunIntensity: mix(start.sunIntensity, end.sunIntensity, amount),
    sunColor: mixColor(start.sunColor, end.sunColor, amount),
    skyColor: mixColor(start.skyColor, end.skyColor, amount),
    groundColor: mixColor(start.groundColor, end.groundColor, amount),
    hemisphereIntensity: mix(start.hemisphereIntensity, end.hemisphereIntensity, amount),
    backdropColor: mixColor(start.backdropColor, end.backdropColor, amount),
  };
}

/** The two anchors of a table either side of an hour, and how far the hour lies from the first toward the second. */
function anchorsAround<T>(anchors: readonly (readonly [hour: number, light: T])[], hourOfDay: number): { from: T; to: T; amount: number } {
  const next = anchors.findIndex(([hour]) => hour > hourOfDay);
  const [fromHour, from] = anchors[next - 1]!;
  const [toHour, to] = anchors[next]!;
  return { from, to, amount: (hourOfDay - fromHour) / (toHour - fromHour) };
}

function lightOf(anchor: LightAnchor): Omit<SunState, 'direction'> {
  return {
    sunIntensity: anchor.sun,
    sunColor: linearColor(anchor.sunColor),
    skyColor: linearColor(anchor.sky),
    groundColor: linearColor(anchor.ground),
    hemisphereIntensity: anchor.hemisphere,
    backdropColor: linearColor(anchor.backdrop),
  };
}

/** An sRGB hex colour in linear RGB, by the transfer function three.js decodes sRGB with. */
function linearColor(hex: number): LinearColor {
  const channel = (byte: number): number => {
    const value = byte / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return { r: channel((hex >> 16) & 0xff), g: channel((hex >> 8) & 0xff), b: channel(hex & 0xff) };
}

function normalize(vector: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function mix(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function mixColor(from: LinearColor, to: LinearColor, amount: number): LinearColor {
  return { r: mix(from.r, to.r, amount), g: mix(from.g, to.g, amount), b: mix(from.b, to.b, amount) };
}
