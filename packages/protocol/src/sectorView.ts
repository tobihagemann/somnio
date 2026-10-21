import { SOMNIO_PROTOCOL_CONSTANTS } from './constants.ts';
import { WireDecodingError } from './errors.ts';
import {
  PROTOCOL_BYTE_CAPS,
  isAbsent,
  mapArray,
  mapRecords,
  requireArray,
  requireBoundedString,
  requireFloat,
  requireId,
  requireInt32,
  requireMetres,
  requireNested,
  requirePositiveMetres,
  requireString,
  requireStringEnum,
  requireUnitInterval,
  requireWithinByteCap,
} from './validate.ts';

/**
 * Everything a client needs from a sector, declared once: the wire carries this shape and the
 * sector file is this shape plus the server-side content. Lengths are metres, `x` runs east and
 * `z` south, and angles are degrees counter-clockwise seen from above. Property names are the
 * JSON keys verbatim, so renaming a property changes both the wire and the file.
 */

export const SECTOR_KINDS = ['outdoor', 'interior'] as const;
export type SectorKind = (typeof SECTOR_KINDS)[number];

export const GROUND_SHAPE_KINDS = ['stroke', 'polygon'] as const;
export type GroundShapeKind = (typeof GROUND_SHAPE_KINDS)[number];

export interface GroundPoint {
  x: number;
  z: number;
}

/**
 * A round-capped polyline `radius` wide on each side, a single point making a dab, or a polygon
 * filled even-odd. Points are sector-relative, like every other record's.
 */
export type GroundShape = { kind: 'stroke'; radius: number; points: GroundPoint[] } | { kind: 'polygon'; points: GroundPoint[] };

/** Paint on the ground: one material laid over the background, its edge feathered. */
export interface GroundMark {
  id: string;
  materialId: string;
  /** 0 to 1. */
  opacity: number;
  shape: GroundShape;
}

/** What a sector's ground is painted with: a background material and the marks over it, in paint order. */
export interface Ground {
  backgroundMaterialId: string;
  marks: GroundMark[];
}

export interface Placement {
  id: string;
  modelId: string;
  x: number;
  z: number;
  yaw: number;
  /** Lifts the model visually; collision stays on the ground. */
  elevation: number;
}

export interface Blocker {
  id: string;
  x: number;
  z: number;
  width: number;
  depth: number;
}

export interface Door {
  id: string;
  /** The placement whose model carries the door anchor. */
  placement: string;
  anchor: string;
  target: { sector: string; door: string };
}

export interface SectorView {
  name: string;
  kind: SectorKind;
  /** Where the sector sits in the outdoor space. Outdoor only: an interior is its own space. */
  origin?: { x: number; z: number };
  /** Percent, 0-100. Interior only: outdoor light comes from the world clock. */
  brightness?: number;
  size: { width: number; depth: number };
  ground: Ground;
  placements: Placement[];
  blockers: Blocker[];
  doors: Door[];
}

function decodeOrigin(container: Record<string, unknown>, path: string): NonNullable<SectorView['origin']> {
  return {
    x: requireMetres(container, 'x', path),
    z: requireMetres(container, 'z', path),
  };
}

function decodeBrightness(container: Record<string, unknown>, path: string): number {
  const brightness = requireInt32(container, 'brightness', path);
  if (brightness < 0 || brightness > 100) {
    throw new WireDecodingError(`${path}.brightness`, `expected a percentage from 0 to 100, got ${brightness}`);
  }
  return brightness;
}

function decodeSize(container: Record<string, unknown>, path: string): SectorView['size'] {
  return {
    width: requireSectorExtent(container, 'width', path),
    depth: requireSectorExtent(container, 'depth', path),
  };
}

function requireSectorExtent(container: Record<string, unknown>, key: string, path: string): number {
  const value = requirePositiveMetres(container, key, path);
  if (value > SOMNIO_PROTOCOL_CONSTANTS.maxSectorExtentMetres) {
    throw new WireDecodingError(`${path}.${key}`, `exceeds ${SOMNIO_PROTOCOL_CONSTANTS.maxSectorExtentMetres} metres (got ${value})`);
  }
  return value;
}

/** How far past the sector's rect a mark's paint may reach. Far inside the border blend, so a mark paints only the sector and those touching it. */
const MARK_INFLUENCE_MARGIN_METRES = 1.5;
/** Rounding slack on the point bound, so a point a producer clamped onto it, or a radius capped at `maxMarkRadius`, is never refused. */
const POINT_BOUND_SLACK = 1e-9;

/** How far past its shape's edge a mark can paint: half the feather, plus the most the edge noise moves it. */
export function markReach(): number {
  return SOMNIO_PROTOCOL_CONSTANTS.markFeatherMetres / 2 + SOMNIO_PROTOCOL_CONSTANTS.markEdgeNoiseMetres;
}

/** The sector-relative rect a mark's shape covers: its points' bounds grown by its radius. */
export function markShapeBounds(shape: GroundShape): { x: number; z: number; width: number; depth: number } {
  const xs = shape.points.map((point) => point.x);
  const zs = shape.points.map((point) => point.z);
  const grown = shape.kind === 'stroke' ? shape.radius : 0;
  const x = Math.min(...xs) - grown;
  const z = Math.min(...zs) - grown;
  return { x, z, width: Math.max(...xs) + grown - x, depth: Math.max(...zs) + grown - z };
}

/** The sector-relative rect a mark can paint within: its shape's bounds grown by its reach. */
export function markInfluence(shape: GroundShape): { x: number; z: number; width: number; depth: number } {
  const bounds = markShapeBounds(shape);
  const reach = markReach();
  return { x: bounds.x - reach, z: bounds.z - reach, width: bounds.width + 2 * reach, depth: bounds.depth + 2 * reach };
}

/** The widest stroke a sector of this size takes: the protocol's cap, or less where a wider one would have nowhere its points may lie. */
export function maxMarkRadius(size: SectorView['size']): number {
  return Math.min(SOMNIO_PROTOCOL_CONSTANTS.maxMarkStrokeRadiusMetres, Math.min(size.width, size.depth) / 2 + MARK_INFLUENCE_MARGIN_METRES - markReach());
}

/**
 * The sector-relative rect a shape's points must lie in for its influence to stay within the
 * sector's rect grown by the influence margin: that rect shrunk by the mark's reach, and for a
 * stroke by its radius too. `undefined` for a stroke too wide for the sector to hold anywhere.
 */
export function markPointBounds(
  size: SectorView['size'],
  shape: { kind: GroundShapeKind; radius?: number },
): { x: number; z: number; width: number; depth: number } | undefined {
  const inset = (shape.kind === 'stroke' ? (shape.radius ?? 0) : 0) + markReach() - MARK_INFLUENCE_MARGIN_METRES;
  const width = size.width - 2 * inset;
  const depth = size.depth - 2 * inset;
  if (width < -POINT_BOUND_SLACK || depth < -POINT_BOUND_SLACK) return undefined;
  return { x: inset, z: inset, width: Math.max(width, 0), depth: Math.max(depth, 0) };
}

function decodeGroundPoint(container: Record<string, unknown>, path: string): GroundPoint {
  return { x: requireMetres(container, 'x', path), z: requireMetres(container, 'z', path) };
}

function decodeGroundShape(container: Record<string, unknown>, path: string, size: SectorView['size']): GroundShape {
  const kind = requireStringEnum(container, 'kind', path, GROUND_SHAPE_KINDS);
  const points = mapArray(container, 'points', path, SOMNIO_PROTOCOL_CONSTANTS.maxSectorGroundPoints, decodeGroundPoint);
  const fewest = kind === 'stroke' ? 1 : 3;
  if (points.length < fewest) throw new WireDecodingError(`${path}.points`, `a ${kind} needs at least ${fewest} points, got ${points.length}`);
  let shape: GroundShape;
  if (kind === 'stroke') {
    const radius = requireMetres(container, 'radius', path);
    if (radius < 0 || radius > SOMNIO_PROTOCOL_CONSTANTS.maxMarkStrokeRadiusMetres) {
      throw new WireDecodingError(`${path}.radius`, `expected 0 to ${SOMNIO_PROTOCOL_CONSTANTS.maxMarkStrokeRadiusMetres} metres, got ${radius}`);
    }
    shape = { kind, radius, points };
  } else {
    shape = { kind, points };
  }
  const bounds = markPointBounds(size, shape);
  const outside = points.findIndex(
    (point) =>
      bounds === undefined ||
      point.x < bounds.x - POINT_BOUND_SLACK ||
      point.x > bounds.x + bounds.width + POINT_BOUND_SLACK ||
      point.z < bounds.z - POINT_BOUND_SLACK ||
      point.z > bounds.z + bounds.depth + POINT_BOUND_SLACK,
  );
  if (outside !== -1) {
    throw new WireDecodingError(`${path}.points[${outside}]`, `paints more than ${MARK_INFLUENCE_MARGIN_METRES} metres past the sector`);
  }
  return shape;
}

function decodeGroundMark(container: Record<string, unknown>, path: string, size: SectorView['size']): GroundMark {
  return {
    id: requireId(container, 'id', path),
    materialId: requireString(container, 'materialId', path),
    opacity: isAbsent(container, 'opacity') ? 1 : requireUnitInterval(container, 'opacity', path),
    shape: decodeGroundShape(requireNested(container, 'shape', path), `${path}.shape`, size),
  };
}

/**
 * The marks are counted, and so are their points all together, before any mark is decoded: the
 * point cap is on the whole ground, so a decoder that met it mark by mark would already have walked
 * every point.
 */
function decodeGround(container: Record<string, unknown>, path: string, size: SectorView['size']): Ground {
  const marks = isAbsent(container, 'marks') ? [] : requireArray(container, 'marks', path);
  if (marks.length > SOMNIO_PROTOCOL_CONSTANTS.maxSectorGroundMarks) {
    throw new WireDecodingError(`${path}.marks`, `exceeds ${SOMNIO_PROTOCOL_CONSTANTS.maxSectorGroundMarks} records (got ${marks.length})`);
  }
  let pointCount = 0;
  for (const mark of marks) {
    const points = (mark as { shape?: { points?: unknown } } | null)?.shape?.points;
    if (Array.isArray(points)) pointCount += points.length;
  }
  if (pointCount > SOMNIO_PROTOCOL_CONSTANTS.maxSectorGroundPoints) {
    throw new WireDecodingError(`${path}.marks`, `exceeds ${SOMNIO_PROTOCOL_CONSTANTS.maxSectorGroundPoints} points in total (got ${pointCount})`);
  }
  return {
    backgroundMaterialId: requireString(container, 'backgroundMaterialId', path),
    marks: mapRecords(container, 'marks', path, SOMNIO_PROTOCOL_CONSTANTS.maxSectorGroundMarks, (element, elementPath) =>
      decodeGroundMark(element, elementPath, size),
    ),
  };
}

function decodePlacement(container: Record<string, unknown>, path: string): Placement {
  return {
    id: requireId(container, 'id', path),
    modelId: requireString(container, 'modelId', path),
    x: requireMetres(container, 'x', path),
    z: requireMetres(container, 'z', path),
    yaw: isAbsent(container, 'yaw') ? 0 : requireFloat(container, 'yaw', path),
    elevation: isAbsent(container, 'elevation') ? 0 : requireMetres(container, 'elevation', path),
  };
}

function decodeBlocker(container: Record<string, unknown>, path: string): Blocker {
  return {
    id: requireId(container, 'id', path),
    x: requireMetres(container, 'x', path),
    z: requireMetres(container, 'z', path),
    width: requirePositiveMetres(container, 'width', path),
    depth: requirePositiveMetres(container, 'depth', path),
  };
}

function decodeDoor(container: Record<string, unknown>, path: string): Door {
  const target = requireNested(container, 'target', path);
  return {
    id: requireId(container, 'id', path),
    placement: requireId(container, 'placement', path),
    anchor: requireString(container, 'anchor', path),
    target: {
      // May be empty: a door that names no counterpart yet is inert, not malformed.
      sector: requireWithinByteCap(requireString(target, 'sector', `${path}.target`), PROTOCOL_BYTE_CAPS.sectorName, `${path}.target.sector`),
      door: requireId(target, 'door', `${path}.target`),
    },
  };
}

/**
 * Decodes a sector from the wire or, with `name` injected, from a sector file. `yaw` and
 * `elevation` default to 0, a mark's `opacity` to 1, and the record arrays and the ground's marks
 * to empty, so the decoded value always carries them whichever form it was read from.
 */
export function decodeSectorView(container: Record<string, unknown>, path: string): SectorView {
  const kind = requireStringEnum(container, 'kind', path, SECTOR_KINDS);
  const forbidden = kind === 'outdoor' ? 'brightness' : 'origin';
  if (!isAbsent(container, forbidden)) {
    throw new WireDecodingError(`${path}.${forbidden}`, `not allowed on an ${kind} sector`);
  }
  const size = decodeSize(requireNested(container, 'size', path), `${path}.size`);
  const placements = mapRecords(container, 'placements', path, SOMNIO_PROTOCOL_CONSTANTS.maxSectorPlacements, decodePlacement);
  const placementIds = new Set(placements.map((placement) => placement.id));
  const doors = mapRecords(container, 'doors', path, SOMNIO_PROTOCOL_CONSTANTS.maxSectorDoors, decodeDoor);
  doors.forEach((door, index) => {
    if (!placementIds.has(door.placement)) {
      throw new WireDecodingError(`${path}.doors[${index}].placement`, `no placement "${door.placement}" in this sector`);
    }
  });
  return {
    name: requireBoundedString(container, 'name', path, PROTOCOL_BYTE_CAPS.sectorName),
    kind,
    ...(kind === 'outdoor'
      ? { origin: decodeOrigin(requireNested(container, 'origin', path), `${path}.origin`) }
      : { brightness: decodeBrightness(container, path) }),
    size,
    ground: decodeGround(requireNested(container, 'ground', path), `${path}.ground`, size),
    placements,
    blockers: mapRecords(container, 'blockers', path, SOMNIO_PROTOCOL_CONSTANTS.maxSectorBlockers, decodeBlocker),
    doors,
  };
}

/**
 * The plain-JSON form with every default left out: `yaw` and `elevation` at 0, a mark's `opacity`
 * at 1, empty record arrays and marks, and an unset `origin` or `brightness`. It is the inverse of
 * `decodeSectorView`, so the two together are the one definition of an omitted default. Nothing is validated or dropped
 * here: a `brightness` set on an outdoor sector is emitted, for the decoder to refuse.
 */
export function encodeSectorView(view: SectorView): Record<string, unknown> {
  return {
    name: view.name,
    kind: view.kind,
    ...(view.origin === undefined ? {} : { origin: view.origin }),
    ...(view.brightness === undefined ? {} : { brightness: view.brightness }),
    size: view.size,
    ground: {
      backgroundMaterialId: view.ground.backgroundMaterialId,
      ...(view.ground.marks.length === 0 ? {} : { marks: view.ground.marks.map(encodeGroundMark) }),
    },
    ...(view.placements.length === 0 ? {} : { placements: view.placements.map(encodePlacement) }),
    ...(view.blockers.length === 0 ? {} : { blockers: view.blockers }),
    ...(view.doors.length === 0 ? {} : { doors: view.doors }),
  };
}

function encodePlacement(placement: Placement): Record<string, unknown> {
  return {
    id: placement.id,
    modelId: placement.modelId,
    x: placement.x,
    z: placement.z,
    ...(placement.yaw === 0 ? {} : { yaw: placement.yaw }),
    ...(placement.elevation === 0 ? {} : { elevation: placement.elevation }),
  };
}

function encodeGroundMark(mark: GroundMark): Record<string, unknown> {
  return {
    id: mark.id,
    materialId: mark.materialId,
    ...(mark.opacity === 1 ? {} : { opacity: mark.opacity }),
    shape: mark.shape,
  };
}
