import {
  mapArray,
  requireBool,
  requireFloat,
  requireInt16,
  requireNested,
  requireRawEnum,
  requireString,
} from './validate'

/**
 * Mirror of `Sources/SomnioProtocol/WireDTOs.swift`. Property names are the JSON keys
 * verbatim — the Swift payloads use synthesized `Codable`, so renaming a property there
 * changes the wire key, and the golden-frame fixtures are what catch that drift.
 */

export interface WireGridSize {
  width: number
  height: number
}

export interface WireLightSetting {
  indoor: boolean
  brightness: number
}

export interface WireObject {
  x: number
  y: number
  modelID: string
  sourceWidth: number
  sourceHeight: number
  priority: number
  /** Yaw in degrees counter-clockwise seen from above; 0 = as authored. */
  rotation: number
}

export interface WireCollisionMask {
  x: number
  y: number
  width: number
  height: number
}

export interface WireSectorPortal {
  x: number
  y: number
  width: number
  height: number
  targetSectorName: string
  direction: number
}

export interface WireNPC {
  spawnX: number
  spawnY: number
  spawnBoxWidth: number
  spawnBoxHeight: number
  maskWidth: number
  maskHeight: number
  name: string
  figure: number
  /** Continuous heading in degrees, unlike `WireSectorPortal.direction`. */
  direction: number
  behaviorTag: number
  dialogScript: string
}

export interface WireMonsterSpawn {
  spawnX: number
  spawnY: number
  spawnBoxWidth: number
  spawnBoxHeight: number
  monsterWidth: number
  monsterHeight: number
  name: string
  figure: number
  bounded: boolean
  spawnHP: number
  spawnBalance: number
  spawnMana: number
  aiScriptIndex: number
}

export interface WireFloorPatch {
  floorMaterialID: string
  x: number
  y: number
  width: number
  height: number
}

export interface WireSector {
  name: string
  version: number
  dimensions: WireGridSize
  floorMaterialID: string
  light: WireLightSetting
  objects: WireObject[]
  collisionMasks: WireCollisionMask[]
  portals: WireSectorPortal[]
  npcs: WireNPC[]
  monsterSpawns: WireMonsterSpawn[]
  floorPatches: WireFloorPatch[]
}

export interface WireInventoryExtra {
  key: string
  value: number
}

/**
 * Mirror of `WireHand`. **Note the off-by-one against the client-level `Hand`**, which is `0 = left,
 * 1 = right, undefined = unequipped`: the wire spends 0 on "no hand" and shifts the two hands up.
 * Two numerically different vocabularies for one concept is exactly why both are named rather than
 * spelled as bare literals at the call sites that convert between them.
 */
export const WIRE_HAND = { none: 0, left: 1, right: 2 } as const
export const WIRE_HAND_VALUES = Object.values(WIRE_HAND)
export type WireHand = (typeof WIRE_HAND)[keyof typeof WIRE_HAND]

export interface WireInventoryRow {
  slot: number
  category: number
  itemId: number
  extras: WireInventoryExtra[]
  equippedHand: WireHand
}

// MARK: - Decoders

export function decodeWireGridSize(container: Record<string, unknown>, path: string): WireGridSize {
  return {
    width: requireInt16(container, 'width', path),
    height: requireInt16(container, 'height', path),
  }
}

export function decodeWireLightSetting(container: Record<string, unknown>, path: string): WireLightSetting {
  return {
    indoor: requireBool(container, 'indoor', path),
    brightness: requireInt16(container, 'brightness', path),
  }
}

export function decodeWireObject(container: Record<string, unknown>, path: string): WireObject {
  return {
    x: requireInt16(container, 'x', path),
    y: requireInt16(container, 'y', path),
    modelID: requireString(container, 'modelID', path),
    sourceWidth: requireInt16(container, 'sourceWidth', path),
    sourceHeight: requireInt16(container, 'sourceHeight', path),
    priority: requireInt16(container, 'priority', path),
    rotation: requireInt16(container, 'rotation', path),
  }
}

export function decodeWireCollisionMask(container: Record<string, unknown>, path: string): WireCollisionMask {
  return {
    x: requireInt16(container, 'x', path),
    y: requireInt16(container, 'y', path),
    width: requireInt16(container, 'width', path),
    height: requireInt16(container, 'height', path),
  }
}

export function decodeWireSectorPortal(container: Record<string, unknown>, path: string): WireSectorPortal {
  return {
    x: requireInt16(container, 'x', path),
    y: requireInt16(container, 'y', path),
    width: requireInt16(container, 'width', path),
    height: requireInt16(container, 'height', path),
    targetSectorName: requireString(container, 'targetSectorName', path),
    direction: requireInt16(container, 'direction', path),
  }
}

export function decodeWireNPC(container: Record<string, unknown>, path: string): WireNPC {
  return {
    spawnX: requireInt16(container, 'spawnX', path),
    spawnY: requireInt16(container, 'spawnY', path),
    spawnBoxWidth: requireInt16(container, 'spawnBoxWidth', path),
    spawnBoxHeight: requireInt16(container, 'spawnBoxHeight', path),
    maskWidth: requireInt16(container, 'maskWidth', path),
    maskHeight: requireInt16(container, 'maskHeight', path),
    name: requireString(container, 'name', path),
    figure: requireInt16(container, 'figure', path),
    direction: requireFloat(container, 'direction', path),
    behaviorTag: requireInt16(container, 'behaviorTag', path),
    dialogScript: requireString(container, 'dialogScript', path),
  }
}

export function decodeWireMonsterSpawn(container: Record<string, unknown>, path: string): WireMonsterSpawn {
  return {
    spawnX: requireInt16(container, 'spawnX', path),
    spawnY: requireInt16(container, 'spawnY', path),
    spawnBoxWidth: requireInt16(container, 'spawnBoxWidth', path),
    spawnBoxHeight: requireInt16(container, 'spawnBoxHeight', path),
    monsterWidth: requireInt16(container, 'monsterWidth', path),
    monsterHeight: requireInt16(container, 'monsterHeight', path),
    name: requireString(container, 'name', path),
    figure: requireInt16(container, 'figure', path),
    bounded: requireBool(container, 'bounded', path),
    spawnHP: requireInt16(container, 'spawnHP', path),
    spawnBalance: requireInt16(container, 'spawnBalance', path),
    spawnMana: requireInt16(container, 'spawnMana', path),
    aiScriptIndex: requireInt16(container, 'aiScriptIndex', path),
  }
}

export function decodeWireFloorPatch(container: Record<string, unknown>, path: string): WireFloorPatch {
  return {
    floorMaterialID: requireString(container, 'floorMaterialID', path),
    x: requireInt16(container, 'x', path),
    y: requireInt16(container, 'y', path),
    width: requireInt16(container, 'width', path),
    height: requireInt16(container, 'height', path),
  }
}

/**
 * `floorPatches` is required on the wire (unlike the on-disk sector format, where it is
 * optional-with-default) — `WireSector` declares it non-optional, which is half of why
 * `helloVersion` went to 3. So it decodes through the same required path as every sibling key,
 * with no absent-key fallback; a server omitting it is a version-skew bug the hello gate should
 * already have caught.
 */
export function decodeWireSector(container: Record<string, unknown>, path: string): WireSector {
  return {
    name: requireString(container, 'name', path),
    version: requireInt16(container, 'version', path),
    dimensions: decodeWireGridSize(requireNested(container, 'dimensions', path), `${path}.dimensions`),
    floorMaterialID: requireString(container, 'floorMaterialID', path),
    light: decodeWireLightSetting(requireNested(container, 'light', path), `${path}.light`),
    objects: mapArray(container, 'objects', path, decodeWireObject),
    collisionMasks: mapArray(container, 'collisionMasks', path, decodeWireCollisionMask),
    portals: mapArray(container, 'portals', path, decodeWireSectorPortal),
    npcs: mapArray(container, 'npcs', path, decodeWireNPC),
    monsterSpawns: mapArray(container, 'monsterSpawns', path, decodeWireMonsterSpawn),
    floorPatches: mapArray(container, 'floorPatches', path, decodeWireFloorPatch),
  }
}

export function decodeWireInventoryExtra(
  container: Record<string, unknown>,
  path: string
): WireInventoryExtra {
  return {
    key: requireString(container, 'key', path),
    value: requireInt16(container, 'value', path),
  }
}

export function decodeWireInventoryRow(container: Record<string, unknown>, path: string): WireInventoryRow {
  return {
    slot: requireInt16(container, 'slot', path),
    category: requireInt16(container, 'category', path),
    itemId: requireInt16(container, 'itemId', path),
    extras: mapArray(container, 'extras', path, decodeWireInventoryExtra),
    equippedHand: requireRawEnum(container, 'equippedHand', path, WIRE_HAND_VALUES),
  }
}
