import { SOMNIO_CONSTANTS, isWithinSectorBounds, isWithinSectorContentBounds } from './constants.ts';
import type { GridPoint, GridSize } from './geometry.ts';
import { clampToInt16 } from './geometry.ts';
import { contains } from './collisionMaskOverlap.ts';
import { heading } from './heading.ts';
import type { Heading } from './heading.ts';
import type { WireSector } from '@somnio/protocol';

/**
 * The sector model plus the hostile-input boundary from the wire. The runtime model is
 * deliberately separate from the wire DTO: the DTO is whatever arrived, the model is what passed
 * validation.
 */

export interface SectorObject {
  x: number;
  y: number;
  modelID: string;
  sourceWidth: number;
  sourceHeight: number;
  priority: number;
  rotation: number;
}

export interface CollisionMask {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FloorPatch {
  floorMaterialID: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Portal kinds and their raw wire values. */
export const PORTAL_DIRECTIONS = {
  outboundTrigger: 0,
  arrivalPlacement: 1,
} as const;
export type PortalDirection = keyof typeof PORTAL_DIRECTIONS;

/** Raw wire value to portal kind; `portalFromWire` rejects an unknown raw value rather than defaulting it. */
export const PORTAL_DIRECTION_BY_RAW: Record<number, PortalDirection> = {
  0: 'outboundTrigger',
  1: 'arrivalPlacement',
};

export interface SectorPortal {
  x: number;
  y: number;
  width: number;
  height: number;
  targetSectorName: string;
  direction: PortalDirection;
}

export interface LightSetting {
  indoor: boolean;
  brightness: number;
}

export interface SectorNPC {
  spawnOrigin: GridPoint;
  spawnBoxSize: GridSize;
  maskSize: GridSize;
  name: string;
  figure: number;
  facing: Heading;
  behaviorTag: number;
  dialogScript: string;
}

export interface MonsterSpawn {
  spawnOrigin: GridPoint;
  spawnBoxSize: GridSize;
  spawnedMonsterSize: GridSize;
  name: string;
  figure: number;
  bounded: boolean;
  spawnHP: number;
  spawnBalance: number;
  spawnMana: number;
  aiScriptIndex: number;
}

export interface Sector {
  name: string;
  version: number;
  dimensions: GridSize;
  floorMaterialID: string;
  light: LightSetting;
  objects: SectorObject[];
  collisionMasks: CollisionMask[];
  portals: SectorPortal[];
  npcs: SectorNPC[];
  monsterSpawns: MonsterSpawn[];
  floorPatches: FloorPatch[];
}

export type SectorConversionErrorKind = 'unknownPortalDirection' | 'sectorDimensionsOutOfRange' | 'sectorContentCountsOutOfRange';

/** Thrown by both directions of the sector↔wire conversion when a guard refuses the input. */
export class SectorConversionError extends Error {
  readonly kind: SectorConversionErrorKind;
  readonly reason: string;

  constructor(kind: SectorConversionErrorKind, reason: string) {
    super(reason);
    this.name = 'SectorConversionError';
    this.kind = kind;
    this.reason = reason;
  }
}

/**
 * The bounds guard both conversion directions apply: the tile dimensions and every record-array
 * count. Without these a peer could drive the receiver into an enormous tile-map allocation, or
 * a quadratic anchor scan that locks the main thread for seconds.
 */
export function requireSectorWithinBounds(sector: Pick<WireSector, 'dimensions'> & SectorContentArrays): void {
  if (!isWithinSectorBounds(sector.dimensions)) {
    throw new SectorConversionError('sectorDimensionsOutOfRange', `sector dimensions out of range: ${sector.dimensions.width}x${sector.dimensions.height}`);
  }
  if (
    !isWithinSectorContentBounds({
      objectCount: sector.objects.length,
      collisionMaskCount: sector.collisionMasks.length,
      portalCount: sector.portals.length,
      npcCount: sector.npcs.length,
      monsterSpawnCount: sector.monsterSpawns.length,
      floorPatchCount: sector.floorPatches.length,
    })
  ) {
    throw new SectorConversionError(
      'sectorContentCountsOutOfRange',
      `sector content counts out of range: ${sector.objects.length} objects, ` +
        `${sector.collisionMasks.length} collision masks, ${sector.portals.length} portals, ` +
        `${sector.npcs.length} npcs, ${sector.monsterSpawns.length} monster spawns, ` +
        `${sector.floorPatches.length} floor patches`,
    );
  }
}

type SectorContentArrays = {
  objects: readonly unknown[];
  collisionMasks: readonly unknown[];
  portals: readonly unknown[];
  npcs: readonly unknown[];
  monsterSpawns: readonly unknown[];
  floorPatches: readonly unknown[];
};

/**
 * The hostile-input boundary. Bounds the tile dimensions and every record-array count, and
 * rejects an unknown portal direction.
 */
export function sectorFromWire(wire: WireSector): Sector {
  requireSectorWithinBounds(wire);

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
  };
}

function portalFromWire(wire: { x: number; y: number; width: number; height: number; targetSectorName: string; direction: number }): SectorPortal {
  const direction = PORTAL_DIRECTION_BY_RAW[wire.direction];
  if (direction === undefined) {
    throw new SectorConversionError('unknownPortalDirection', `unknownPortalDirection(${wire.direction})`);
  }
  return {
    x: wire.x,
    y: wire.y,
    width: wire.width,
    height: wire.height,
    targetSectorName: wire.targetSectorName,
    direction,
  };
}

export function sectorPixelWidth(sector: Sector): number {
  return sector.dimensions.width * SOMNIO_CONSTANTS.tileSize;
}

export function sectorPixelHeight(sector: Sector): number {
  return sector.dimensions.height * SOMNIO_CONSTANTS.tileSize;
}

/** Sector centre in pixel space — the spawn fallback when a sector has no arrival portal. */
export function sectorPixelCenter(sector: Sector): GridPoint {
  return {
    x: clampToInt16(Math.trunc(sectorPixelWidth(sector) / 2)),
    y: clampToInt16(Math.trunc(sectorPixelHeight(sector) / 2)),
  };
}

/** Anchor-point test, not the feet box: use `isFeetClear` for movement. */
export function isWalkable(sector: Sector, position: GridPoint): boolean {
  return (
    position.x >= 0 &&
    position.y >= 0 &&
    position.x < sectorPixelWidth(sector) &&
    position.y < sectorPixelHeight(sector) &&
    !contains(position, sector.collisionMasks)
  );
}

/**
 * Spawn point inside the self-pointing arrival portal. Prefers the portal's geometric centre,
 * but the rect can span collision masks, so a blocked centre falls back to an 8px scan for the
 * walkable cell closest to it. Returns `undefined` when there is no arrival portal targeting
 * this sector, or when the rect is fully blocked; callers fall back to `sectorPixelCenter` in
 * both cases, because returning an unwalkable centre would land the player inside geometry.
 */
export function arrivalSpawn(sector: Sector): GridPoint | undefined {
  const portal = sector.portals.find((candidate) => candidate.direction === 'arrivalPlacement' && candidate.targetSectorName === sector.name);
  if (portal === undefined) return undefined;

  const centerX = portal.x + Math.trunc(portal.width / 2);
  const centerY = portal.y + Math.trunc(portal.height / 2);
  const center = { x: clampToInt16(centerX), y: clampToInt16(centerY) };
  if (isWalkable(sector, center)) return center;

  const step = 8;
  const limitX = portal.x + portal.width;
  const limitY = portal.y + portal.height;
  let best: GridPoint | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let y = portal.y; y < limitY; y += step) {
    for (let x = portal.x; x < limitX; x += step) {
      const candidate = { x: clampToInt16(x), y: clampToInt16(y) };
      if (!isWalkable(sector, candidate)) continue;
      const dx = x - centerX;
      const dy = y - centerY;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
  }
  return best;
}

/**
 * `.outboundTrigger` portal rects paired with their offset in the **full** `portals` array. The
 * server indexes `staticSector.portals[portalIndex]` against the full array, so the offset has
 * to survive the trigger filter — re-enumerating the filtered list sends the wrong index and
 * teleports the player through the wrong portal.
 */
export function portalTriggerRects(sector: Sector): { index: number; rect: PortalRect }[] {
  const triggers: { index: number; rect: PortalRect }[] = [];
  sector.portals.forEach((portal, index) => {
    if (portal.direction !== 'outboundTrigger') return;
    triggers.push({
      index,
      rect: { x: portal.x, y: portal.y, width: portal.width, height: portal.height },
    });
  });
  return triggers;
}

type PortalRect = { x: number; y: number; width: number; height: number };
