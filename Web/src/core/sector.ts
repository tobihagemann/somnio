import { SOMNIO_CONSTANTS, isWithinSectorBounds, isWithinSectorContentBounds } from './constants'
import type { GridPoint, GridSize } from './geometry'
import { clampToInt16 } from './geometry'
import { contains } from './collisionMaskOverlap'
import { heading } from './heading'
import type { Heading } from './heading'
import type { WireSector } from '@/protocol'

/**
 * Mirror of `Sources/SomnioCore/Models/Sector.swift` plus the hostile-input boundary from
 * `Sector(_ wire:)`. The runtime model is deliberately separate from the wire DTO: the DTO is
 * whatever arrived, the model is what passed validation.
 */

export interface SectorObject {
  x: number
  y: number
  modelID: string
  sourceWidth: number
  sourceHeight: number
  priority: number
  rotation: number
}

export interface CollisionMask {
  x: number
  y: number
  width: number
  height: number
}

export interface FloorPatch {
  floorMaterialID: string
  x: number
  y: number
  width: number
  height: number
}

/** Mirror of `PortalDirection`. An unknown raw value is rejected, never silently defaulted. */
export const PORTAL_DIRECTIONS = {
  outboundTrigger: 0,
  arrivalPlacement: 1,
} as const
export type PortalDirection = keyof typeof PORTAL_DIRECTIONS

const PORTAL_DIRECTION_BY_RAW: Record<number, PortalDirection> = {
  0: 'outboundTrigger',
  1: 'arrivalPlacement',
}

export interface SectorPortal {
  x: number
  y: number
  width: number
  height: number
  targetSectorName: string
  direction: PortalDirection
}

export interface LightSetting {
  indoor: boolean
  brightness: number
}

export interface SectorNPC {
  spawnOrigin: GridPoint
  spawnBoxSize: GridSize
  maskSize: GridSize
  name: string
  figure: number
  facing: Heading
  behaviorTag: number
  dialogScript: string
}

export interface MonsterSpawn {
  spawnOrigin: GridPoint
  spawnBoxSize: GridSize
  spawnedMonsterSize: GridSize
  name: string
  figure: number
  bounded: boolean
  spawnHP: number
  spawnBalance: number
  spawnMana: number
  aiScriptIndex: number
}

export interface Sector {
  name: string
  version: number
  dimensions: GridSize
  floorMaterialID: string
  light: LightSetting
  objects: SectorObject[]
  collisionMasks: CollisionMask[]
  portals: SectorPortal[]
  npcs: SectorNPC[]
  monsterSpawns: MonsterSpawn[]
  floorPatches: FloorPatch[]
}

/** Mirror of `WireConversionError`. */
export class SectorConversionError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(reason)
    this.name = 'SectorConversionError'
    this.reason = reason
  }
}

/**
 * The hostile-input boundary, mirroring `Sector(_ wire:)`. Bounds the tile dimensions and every
 * record-array count, and rejects an unknown portal direction. Without these a peer could drive
 * the browser into an enormous tile-map allocation, or a quadratic anchor scan that locks the
 * main thread for seconds.
 */
export function sectorFromWire(wire: WireSector): Sector {
  if (!isWithinSectorBounds(wire.dimensions)) {
    throw new SectorConversionError(
      `sector dimensions out of range: ${wire.dimensions.width}x${wire.dimensions.height}`
    )
  }
  if (
    !isWithinSectorContentBounds({
      objectCount: wire.objects.length,
      collisionMaskCount: wire.collisionMasks.length,
      portalCount: wire.portals.length,
      npcCount: wire.npcs.length,
      monsterSpawnCount: wire.monsterSpawns.length,
      floorPatchCount: wire.floorPatches.length,
    })
  ) {
    throw new SectorConversionError(
      `sector content counts out of range: ${wire.objects.length} objects, ` +
        `${wire.collisionMasks.length} collision masks, ${wire.portals.length} portals, ` +
        `${wire.npcs.length} npcs, ${wire.monsterSpawns.length} monster spawns, ` +
        `${wire.floorPatches.length} floor patches`
    )
  }

  return {
    name: wire.name,
    version: wire.version,
    dimensions: { width: wire.dimensions.width, height: wire.dimensions.height },
    floorMaterialID: wire.floorMaterialID,
    light: { indoor: wire.light.indoor, brightness: wire.light.brightness },
    objects: wire.objects.map((object) => ({ ...object })),
    collisionMasks: wire.collisionMasks.map((mask) => ({ ...mask })),
    portals: wire.portals.map(portalFromWire),
    npcs: wire.npcs.map((npc) => ({
      spawnOrigin: { x: npc.spawnX, y: npc.spawnY },
      spawnBoxSize: { width: npc.spawnBoxWidth, height: npc.spawnBoxHeight },
      maskSize: { width: npc.maskWidth, height: npc.maskHeight },
      name: npc.name,
      figure: npc.figure,
      facing: heading(npc.direction),
      behaviorTag: npc.behaviorTag,
      dialogScript: npc.dialogScript,
    })),
    monsterSpawns: wire.monsterSpawns.map((spawn) => ({
      spawnOrigin: { x: spawn.spawnX, y: spawn.spawnY },
      spawnBoxSize: { width: spawn.spawnBoxWidth, height: spawn.spawnBoxHeight },
      spawnedMonsterSize: { width: spawn.monsterWidth, height: spawn.monsterHeight },
      name: spawn.name,
      figure: spawn.figure,
      bounded: spawn.bounded,
      spawnHP: spawn.spawnHP,
      spawnBalance: spawn.spawnBalance,
      spawnMana: spawn.spawnMana,
      aiScriptIndex: spawn.aiScriptIndex,
    })),
    floorPatches: wire.floorPatches.map((patch) => ({ ...patch })),
  }
}

function portalFromWire(wire: {
  x: number
  y: number
  width: number
  height: number
  targetSectorName: string
  direction: number
}): SectorPortal {
  const direction = PORTAL_DIRECTION_BY_RAW[wire.direction]
  if (direction === undefined) {
    throw new SectorConversionError(`unknownPortalDirection(${wire.direction})`)
  }
  return {
    x: wire.x,
    y: wire.y,
    width: wire.width,
    height: wire.height,
    targetSectorName: wire.targetSectorName,
    direction,
  }
}

export function sectorPixelWidth(sector: Sector): number {
  return sector.dimensions.width * SOMNIO_CONSTANTS.tileSize
}

export function sectorPixelHeight(sector: Sector): number {
  return sector.dimensions.height * SOMNIO_CONSTANTS.tileSize
}

/** Sector centre in pixel space — the spawn fallback when a sector has no arrival portal. */
export function sectorPixelCenter(sector: Sector): GridPoint {
  return {
    x: clampToInt16(Math.trunc(sectorPixelWidth(sector) / 2)),
    y: clampToInt16(Math.trunc(sectorPixelHeight(sector) / 2)),
  }
}

/** `true` when `position` is in bounds and clear of every collision mask — a standable pixel. */
export function isWalkable(sector: Sector, position: GridPoint): boolean {
  return (
    position.x >= 0 &&
    position.y >= 0 &&
    position.x < sectorPixelWidth(sector) &&
    position.y < sectorPixelHeight(sector) &&
    !contains(position, sector.collisionMasks)
  )
}

/**
 * Spawn point inside the self-pointing arrival portal. Prefers the portal's geometric centre,
 * but the rect can span collision masks, so a blocked centre falls back to an 8px scan for the
 * walkable cell closest to it. Returns `undefined` when there is no arrival portal targeting
 * this sector *and* when the rect is fully blocked — callers fall back to `sectorPixelCenter`
 * in both cases, because returning an unwalkable centre would land the player inside geometry.
 */
export function arrivalSpawn(sector: Sector): GridPoint | undefined {
  const portal = sector.portals.find(
    (candidate) => candidate.direction === 'arrivalPlacement' && candidate.targetSectorName === sector.name
  )
  if (portal === undefined) return undefined

  const centerX = portal.x + Math.trunc(portal.width / 2)
  const centerY = portal.y + Math.trunc(portal.height / 2)
  const center = { x: clampToInt16(centerX), y: clampToInt16(centerY) }
  if (isWalkable(sector, center)) return center

  const step = 8
  const limitX = portal.x + portal.width
  const limitY = portal.y + portal.height
  let best: GridPoint | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (let y = portal.y; y < limitY; y += step) {
    for (let x = portal.x; x < limitX; x += step) {
      const candidate = { x: clampToInt16(x), y: clampToInt16(y) }
      if (!isWalkable(sector, candidate)) continue
      const dx = x - centerX
      const dy = y - centerY
      const distance = dx * dx + dy * dy
      if (distance < bestDistance) {
        bestDistance = distance
        best = candidate
      }
    }
  }
  return best
}

/**
 * `.outboundTrigger` portal rects paired with their offset in the **full** `portals` array. The
 * server indexes `staticSector.portals[portalIndex]` against the full array, so the offset has
 * to survive the trigger filter — re-enumerating the filtered list sends the wrong index and
 * teleports the player through the wrong portal.
 */
export function portalTriggerRects(sector: Sector): { index: number; rect: PortalRect }[] {
  const triggers: { index: number; rect: PortalRect }[] = []
  sector.portals.forEach((portal, index) => {
    if (portal.direction !== 'outboundTrigger') return
    triggers.push({
      index,
      rect: { x: portal.x, y: portal.y, width: portal.width, height: portal.height },
    })
  })
  return triggers
}

type PortalRect = { x: number; y: number; width: number; height: number }
