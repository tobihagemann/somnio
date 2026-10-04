import { SOMNIO_PROTOCOL_CONSTANTS } from './constants.ts';
import { WireDecodingError } from './errors.ts';
import {
  PROTOCOL_BYTE_CAPS,
  isAbsent,
  mapRecords,
  requireBoundedString,
  requireFloat,
  requireId,
  requireInt32,
  requireMetres,
  requireNested,
  requirePositiveMetres,
  requireString,
  requireStringEnum,
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

export interface FloorPatch {
  id: string;
  floorMaterialId: string;
  x: number;
  z: number;
  width: number;
  depth: number;
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
  floorMaterialId: string;
  floorPatches: FloorPatch[];
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

function decodeFloorPatch(container: Record<string, unknown>, path: string): FloorPatch {
  return {
    id: requireId(container, 'id', path),
    floorMaterialId: requireString(container, 'floorMaterialId', path),
    x: requireMetres(container, 'x', path),
    z: requireMetres(container, 'z', path),
    width: requirePositiveMetres(container, 'width', path),
    depth: requirePositiveMetres(container, 'depth', path),
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
 * `elevation` default to 0 and the four record arrays to empty, so the decoded value always
 * carries them whichever form it was read from.
 */
export function decodeSectorView(container: Record<string, unknown>, path: string): SectorView {
  const kind = requireStringEnum(container, 'kind', path, SECTOR_KINDS);
  const forbidden = kind === 'outdoor' ? 'brightness' : 'origin';
  if (!isAbsent(container, forbidden)) {
    throw new WireDecodingError(`${path}.${forbidden}`, `not allowed on an ${kind} sector`);
  }
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
    size: decodeSize(requireNested(container, 'size', path), `${path}.size`),
    floorMaterialId: requireString(container, 'floorMaterialId', path),
    floorPatches: mapRecords(container, 'floorPatches', path, SOMNIO_PROTOCOL_CONSTANTS.maxSectorFloorPatches, decodeFloorPatch),
    placements,
    blockers: mapRecords(container, 'blockers', path, SOMNIO_PROTOCOL_CONSTANTS.maxSectorBlockers, decodeBlocker),
    doors,
  };
}

/**
 * The plain-JSON form with every default left out: `yaw` and `elevation` at 0, empty record
 * arrays, and an unset `origin` or `brightness`. It is the inverse of `decodeSectorView`, so the
 * two together are the one definition of an omitted default. Nothing is validated or dropped
 * here: a `brightness` set on an outdoor sector is emitted, for the decoder to refuse.
 */
export function encodeSectorView(view: SectorView): Record<string, unknown> {
  return {
    name: view.name,
    kind: view.kind,
    ...(view.origin === undefined ? {} : { origin: view.origin }),
    ...(view.brightness === undefined ? {} : { brightness: view.brightness }),
    size: view.size,
    floorMaterialId: view.floorMaterialId,
    ...(view.floorPatches.length === 0 ? {} : { floorPatches: view.floorPatches }),
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
