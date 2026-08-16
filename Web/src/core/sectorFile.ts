import { utf8ByteLength } from '@/protocol'
import { SOMNIO_CONSTANTS, isWithinSectorBounds, isWithinSectorContentBounds } from './constants'
import { formatSwiftFloat32 } from './float'
import { INT16_MAX, INT16_MIN } from './geometry'
import { heading } from './heading'
import { PORTAL_DIRECTIONS, PORTAL_DIRECTION_BY_RAW } from './sector'
import type {
  CollisionMask,
  FloorPatch,
  MonsterSpawn,
  Sector,
  SectorNPC,
  SectorObject,
  SectorPortal,
} from './sector'

/**
 * Mirror of `Sources/SomnioCore/MapCodec/MapCodec.swift` — the `.somnio-sector` disk codec.
 *
 * The writer is byte-compatible with `MapCodec.write`'s Foundation output
 * (`[.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]`): 2-space indent, `"key" : value`
 * with a space before the colon, recursively sorted keys, raw `/` and raw UTF-8, an empty array
 * as `[` / blank line / `]`, and no trailing newline — none of which `JSON.stringify` produces.
 * The committed Swift fixtures (plus the synthetic encoding golden) pin the two writers to each
 * other byte for byte.
 *
 * The sector name is never part of the JSON: it is the filename, exactly as
 * `MapCodec.read`'s `SectorBody` carries no name and `Sector(body:name:)` supplies it.
 */

/** Mirror of the `DecodingError`/`EncodingError` boundary — one error type for both directions. */
export class SectorFileError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(reason)
    this.name = 'SectorFileError'
    this.reason = reason
  }
}

// MARK: - Reader

export function readSectorFile(text: string, name: string): Sector {
  // Size preflight in UTF-8 bytes (not UTF-16 code units), before parsing — the count caps
  // below only fire after the whole input is parsed, mirroring `MapCodec.read`.
  const byteCount = utf8ByteLength(text)
  if (byteCount > SOMNIO_CONSTANTS.maxSectorFileBytes) {
    throw new SectorFileError(`sector file size out of range: ${byteCount} bytes`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new SectorFileError(`sector file is not valid JSON: ${String(error)}`)
  }
  const root = requireObject(parsed, 'sector')

  const sector: Sector = {
    name,
    version: requireInt16(root['version'], 'version'),
    dimensions: parseGridSize(root['dimensions'], 'dimensions'),
    floorMaterialID: requireString(root['floorMaterialID'], 'floorMaterialID'),
    light: parseLight(root['light']),
    objects: requireArray(root['objects'], 'objects').map(parseObjectRecord),
    collisionMasks: requireArray(root['collisionMasks'], 'collisionMasks').map(parseCollisionMask),
    portals: requireArray(root['portals'], 'portals').map(parsePortal),
    npcs: requireArray(root['npcs'], 'npcs').map(parseNPC),
    monsterSpawns: requireArray(root['monsterSpawns'], 'monsterSpawns').map(parseMonsterSpawn),
    // A missing `floorPatches` decodes as empty, mirroring `SectorBody.init(from:)`.
    floorPatches:
      root['floorPatches'] === undefined
        ? []
        : requireArray(root['floorPatches'], 'floorPatches').map(parseFloorPatch),
  }

  if (!isWithinSectorBounds(sector.dimensions)) {
    throw new SectorFileError(
      `sector dimensions out of range: ${sector.dimensions.width}x${sector.dimensions.height}`
    )
  }
  requireContentCountsWithinBounds(sector)
  return sector
}

function parseGridSize(value: unknown, label: string): { width: number; height: number } {
  const object = requireObject(value, label)
  return {
    width: requireInt16(object['width'], `${label}.width`),
    height: requireInt16(object['height'], `${label}.height`),
  }
}

function parseGridPoint(value: unknown, label: string): { x: number; y: number } {
  const object = requireObject(value, label)
  return {
    x: requireInt16(object['x'], `${label}.x`),
    y: requireInt16(object['y'], `${label}.y`),
  }
}

function parseLight(value: unknown): { indoor: boolean; brightness: number } {
  const object = requireObject(value, 'light')
  return {
    indoor: requireBoolean(object['indoor'], 'light.indoor'),
    brightness: requireInt16(object['brightness'], 'light.brightness'),
  }
}

function parseObjectRecord(value: unknown): SectorObject {
  const object = requireObject(value, 'object')
  return {
    x: requireInt16(object['x'], 'object.x'),
    y: requireInt16(object['y'], 'object.y'),
    modelID: requireString(object['modelID'], 'object.modelID'),
    sourceWidth: requireInt16(object['sourceWidth'], 'object.sourceWidth'),
    sourceHeight: requireInt16(object['sourceHeight'], 'object.sourceHeight'),
    priority: requireInt16(object['priority'], 'object.priority'),
    // A missing `rotation` decodes as 0, mirroring `Object.init(from:)`.
    rotation: object['rotation'] === undefined ? 0 : requireInt16(object['rotation'], 'object.rotation'),
  }
}

function parseCollisionMask(value: unknown): CollisionMask {
  const object = requireObject(value, 'collisionMask')
  return {
    x: requireInt16(object['x'], 'collisionMask.x'),
    y: requireInt16(object['y'], 'collisionMask.y'),
    width: requireInt16(object['width'], 'collisionMask.width'),
    height: requireInt16(object['height'], 'collisionMask.height'),
  }
}

function parsePortal(value: unknown): SectorPortal {
  const object = requireObject(value, 'portal')
  const raw = requireInt16(object['direction'], 'portal.direction')
  const direction = PORTAL_DIRECTION_BY_RAW[raw]
  if (direction === undefined) {
    throw new SectorFileError(`unknown portal direction: ${raw}`)
  }
  return {
    x: requireInt16(object['x'], 'portal.x'),
    y: requireInt16(object['y'], 'portal.y'),
    width: requireInt16(object['width'], 'portal.width'),
    height: requireInt16(object['height'], 'portal.height'),
    targetSectorName: requireString(object['targetSectorName'], 'portal.targetSectorName'),
    direction,
  }
}

function parseNPC(value: unknown): SectorNPC {
  const object = requireObject(value, 'npc')
  return {
    spawnOrigin: parseGridPoint(object['spawnOrigin'], 'npc.spawnOrigin'),
    spawnBoxSize: parseGridSize(object['spawnBoxSize'], 'npc.spawnBoxSize'),
    maskSize: parseGridSize(object['maskSize'], 'npc.maskSize'),
    name: requireString(object['name'], 'npc.name'),
    figure: requireInt16(object['figure'], 'npc.figure'),
    // `heading()` normalizes an out-of-range persisted value rather than throwing,
    // matching `Heading.init(degrees:)`.
    facing: heading(requireNumber(object['direction'], 'npc.direction')),
    behaviorTag: requireInt16(object['behaviorTag'], 'npc.behaviorTag'),
    dialogScript: requireString(object['dialogScript'], 'npc.dialogScript'),
  }
}

function parseMonsterSpawn(value: unknown): MonsterSpawn {
  const object = requireObject(value, 'monsterSpawn')
  return {
    spawnOrigin: parseGridPoint(object['spawnOrigin'], 'monsterSpawn.spawnOrigin'),
    spawnBoxSize: parseGridSize(object['spawnBoxSize'], 'monsterSpawn.spawnBoxSize'),
    spawnedMonsterSize: parseGridSize(object['spawnedMonsterSize'], 'monsterSpawn.spawnedMonsterSize'),
    name: requireString(object['name'], 'monsterSpawn.name'),
    figure: requireInt16(object['figure'], 'monsterSpawn.figure'),
    bounded: requireBoolean(object['bounded'], 'monsterSpawn.bounded'),
    spawnHP: requireInt16(object['spawnHP'], 'monsterSpawn.spawnHP'),
    spawnBalance: requireInt16(object['spawnBalance'], 'monsterSpawn.spawnBalance'),
    spawnMana: requireInt16(object['spawnMana'], 'monsterSpawn.spawnMana'),
    aiScriptIndex: requireInt16(object['aiScriptIndex'], 'monsterSpawn.aiScriptIndex'),
  }
}

function parseFloorPatch(value: unknown): FloorPatch {
  const object = requireObject(value, 'floorPatch')
  return {
    floorMaterialID: requireString(object['floorMaterialID'], 'floorPatch.floorMaterialID'),
    x: requireInt16(object['x'], 'floorPatch.x'),
    y: requireInt16(object['y'], 'floorPatch.y'),
    width: requireInt16(object['width'], 'floorPatch.width'),
    height: requireInt16(object['height'], 'floorPatch.height'),
  }
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SectorFileError(`${label} is not an object`)
  }
  return value as Record<string, unknown>
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new SectorFileError(`${label} is not an array`)
  return value
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new SectorFileError(`${label} is not a string`)
  return value
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new SectorFileError(`${label} is not a boolean`)
  return value
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== 'number') throw new SectorFileError(`${label} is not a number`)
  return value
}

/**
 * TypeScript's `number` is unrestricted where the Swift model is `Int16`, so both directions
 * check every persisted integer — an inspector that accepted `1.5` or `40000` would otherwise
 * write a file `MapCodec.read` rejects, surfacing the failure at server startup instead of
 * at save.
 */
function requireInt16(value: unknown, label: string): number {
  const number = requireNumber(value, label)
  if (!Number.isInteger(number) || number < INT16_MIN || number > INT16_MAX) {
    throw new SectorFileError(`${label} is not an Int16: ${number}`)
  }
  return number
}

// MARK: - Writer

/**
 * Mirrors `MapCodec.write`'s guard order: dimensions, content counts, then — after
 * serializing — the UTF-8 byte cap, so the writer can never persist a file its own
 * reader (or the Swift one) would refuse.
 */
export function writeSectorFile(sector: Sector): string {
  if (!isWithinSectorBounds(sector.dimensions)) {
    throw new SectorFileError(
      `sector dimensions out of range: ${sector.dimensions.width}x${sector.dimensions.height}`
    )
  }
  requireContentCountsWithinBounds(sector)
  const text = serialize(diskBody(sector), '')
  const byteCount = utf8ByteLength(text)
  if (byteCount > SOMNIO_CONSTANTS.maxSectorFileBytes) {
    throw new SectorFileError(`sector file size out of range: ${byteCount} bytes`)
  }
  return text
}

function requireContentCountsWithinBounds(sector: Sector): void {
  const counts = {
    objectCount: sector.objects.length,
    collisionMaskCount: sector.collisionMasks.length,
    portalCount: sector.portals.length,
    npcCount: sector.npcs.length,
    monsterSpawnCount: sector.monsterSpawns.length,
    floorPatchCount: sector.floorPatches.length,
  }
  if (!isWithinSectorContentBounds(counts)) {
    throw new SectorFileError(
      `sector content counts out of range: ${counts.objectCount} objects, ` +
        `${counts.collisionMaskCount} collision masks, ${counts.portalCount} portals, ` +
        `${counts.npcCount} npcs, ${counts.monsterSpawnCount} monster spawns, ` +
        `${counts.floorPatchCount} floor patches`
    )
  }
}

type DiskValue = number | boolean | string | DiskValue[] | DiskObject
interface DiskObject {
  [key: string]: DiskValue
}

/** The on-disk shape: nameless, with `NPC.facing` under `"direction"` and portals as raw `0|1`. */
function diskBody(sector: Sector): DiskObject {
  const root: DiskObject = {
    version: int16(sector.version, 'version'),
    dimensions: diskGridSize(sector.dimensions, 'dimensions'),
    floorMaterialID: sector.floorMaterialID,
    light: {
      indoor: sector.light.indoor,
      brightness: int16(sector.light.brightness, 'light.brightness'),
    },
    objects: sector.objects.map((object) => {
      const record: DiskObject = {
        x: int16(object.x, 'object.x'),
        y: int16(object.y, 'object.y'),
        modelID: object.modelID,
        sourceWidth: int16(object.sourceWidth, 'object.sourceWidth'),
        sourceHeight: int16(object.sourceHeight, 'object.sourceHeight'),
        priority: int16(object.priority, 'object.priority'),
      }
      // A zero rotation is omitted, mirroring `Object.encode(to:)`.
      if (int16(object.rotation, 'object.rotation') !== 0) record['rotation'] = object.rotation
      return record
    }),
    collisionMasks: sector.collisionMasks.map((mask) => ({
      x: int16(mask.x, 'collisionMask.x'),
      y: int16(mask.y, 'collisionMask.y'),
      width: int16(mask.width, 'collisionMask.width'),
      height: int16(mask.height, 'collisionMask.height'),
    })),
    portals: sector.portals.map((portal) => ({
      x: int16(portal.x, 'portal.x'),
      y: int16(portal.y, 'portal.y'),
      width: int16(portal.width, 'portal.width'),
      height: int16(portal.height, 'portal.height'),
      targetSectorName: portal.targetSectorName,
      direction: PORTAL_DIRECTIONS[portal.direction],
    })),
    npcs: sector.npcs.map((npc) => ({
      spawnOrigin: diskGridPoint(npc.spawnOrigin, 'npc.spawnOrigin'),
      spawnBoxSize: diskGridSize(npc.spawnBoxSize, 'npc.spawnBoxSize'),
      maskSize: diskGridSize(npc.maskSize, 'npc.maskSize'),
      name: npc.name,
      figure: int16(npc.figure, 'npc.figure'),
      direction: npc.facing,
      behaviorTag: int16(npc.behaviorTag, 'npc.behaviorTag'),
      dialogScript: npc.dialogScript,
    })),
    monsterSpawns: sector.monsterSpawns.map((spawn) => ({
      spawnOrigin: diskGridPoint(spawn.spawnOrigin, 'monsterSpawn.spawnOrigin'),
      spawnBoxSize: diskGridSize(spawn.spawnBoxSize, 'monsterSpawn.spawnBoxSize'),
      spawnedMonsterSize: diskGridSize(spawn.spawnedMonsterSize, 'monsterSpawn.spawnedMonsterSize'),
      name: spawn.name,
      figure: int16(spawn.figure, 'monsterSpawn.figure'),
      bounded: spawn.bounded,
      spawnHP: int16(spawn.spawnHP, 'monsterSpawn.spawnHP'),
      spawnBalance: int16(spawn.spawnBalance, 'monsterSpawn.spawnBalance'),
      spawnMana: int16(spawn.spawnMana, 'monsterSpawn.spawnMana'),
      aiScriptIndex: int16(spawn.aiScriptIndex, 'monsterSpawn.aiScriptIndex'),
    })),
  }
  // An empty `floorPatches` is omitted, mirroring `SectorBody.encode(to:)`.
  if (sector.floorPatches.length > 0) {
    root['floorPatches'] = sector.floorPatches.map((patch) => ({
      floorMaterialID: patch.floorMaterialID,
      x: int16(patch.x, 'floorPatch.x'),
      y: int16(patch.y, 'floorPatch.y'),
      width: int16(patch.width, 'floorPatch.width'),
      height: int16(patch.height, 'floorPatch.height'),
    }))
  }
  return root
}

function diskGridSize(size: { width: number; height: number }, label: string): DiskObject {
  return { width: int16(size.width, `${label}.width`), height: int16(size.height, `${label}.height`) }
}

function diskGridPoint(point: { x: number; y: number }, label: string): DiskObject {
  return { x: int16(point.x, `${label}.x`), y: int16(point.y, `${label}.y`) }
}

function int16(value: number, label: string): number {
  return requireInt16(value, label)
}

/**
 * Foundation's pretty printer, reproduced: `"key" : value`, 2-space indent, recursively
 * sorted keys, and the empty array as an open bracket, a blank line, and the closing bracket
 * at the key's own indent. Strings go through `JSON.stringify`, which matches Foundation's
 * escaping under `.withoutEscapingSlashes` — `"` `\` and control characters escape, `/` and
 * non-ASCII stay raw.
 *
 * The one non-integer number in the model is the NPC heading, so the number rule is: integers
 * print bare, anything fractional prints as Foundation's shortest-Float32 decimal.
 */
function serialize(value: DiskValue, indent: string): string {
  if (typeof value === 'number') {
    // Foundation writes negative zero as `-0` (a heading of `-0.0` survives Swift's
    // normalization), but `String(-0)` is `"0"` — special-case it so a `-0` direction
    // round-trips byte-identically instead of being rewritten to `0`.
    if (Object.is(value, -0)) return '-0'
    return Number.isInteger(value) ? String(value) : formatSwiftFloat32(value)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return JSON.stringify(value)
  const inner = `${indent}  `
  if (Array.isArray(value)) {
    if (value.length === 0) return `[\n\n${indent}]`
    const items = value.map((item) => `${inner}${serialize(item, inner)}`)
    return `[\n${items.join(',\n')}\n${indent}]`
  }
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${inner}${JSON.stringify(key)} : ${serialize(value[key]!, inner)}`)
  return `{\n${entries.join(',\n')}\n${indent}}`
}
