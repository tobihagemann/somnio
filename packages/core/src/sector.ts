import type { NPCService, SectorView } from '@somnio/protocol';
import type { Point, Rect } from './geometry.ts';
import type { Heading } from './heading.ts';
import type { MonsterKindId } from './monsterKinds.ts';

/**
 * The sector model: the client's view of a sector plus the content only the server acts on.
 * Every record position is relative to the sector's own north-west corner.
 */

/** Where a new character enters the world, in the starter sector, and where a dreamer who gave up wakes, in the inn. */
export interface SectorSpawn {
  x: number;
  z: number;
  facing: Heading;
}

export interface SectorNPC {
  id: string;
  name: string;
  characterModelId: string;
  x: number;
  z: number;
  facing: Heading;
  dialogScript: string;
  /** What asking the NPC offers beyond its dialog. */
  service?: NPCService;
}

/** An area that keeps up to `maxAlive` monsters of one kind alive. */
export interface MonsterSpawn {
  id: string;
  kind: MonsterKindId;
  x: number;
  z: number;
  width: number;
  depth: number;
  maxAlive: number;
}

export interface Sector extends SectorView {
  spawn?: SectorSpawn;
  npcs: SectorNPC[];
  monsterSpawns: MonsterSpawn[];
}

/** The subset of a sector a client is sent. */
export function sectorView(sector: Sector): SectorView {
  return {
    name: sector.name,
    kind: sector.kind,
    ...(sector.origin === undefined ? {} : { origin: sector.origin }),
    ...(sector.brightness === undefined ? {} : { brightness: sector.brightness }),
    size: sector.size,
    floorMaterialId: sector.floorMaterialId,
    floorPatches: sector.floorPatches,
    placements: sector.placements,
    blockers: sector.blockers,
    doors: sector.doors,
  };
}

/** Where the sector's north-west corner sits in its space: the `origin` outdoors, the space's own origin for an interior. */
export function sectorOrigin(sector: SectorView): Point {
  return sector.origin ?? { x: 0, z: 0 };
}

/** The ground the sector covers, in its space's coordinates. */
export function sectorRect(sector: SectorView): Rect {
  const origin = sectorOrigin(sector);
  return { x: origin.x, z: origin.z, width: sector.size.width, depth: sector.size.depth };
}

/** A sector-relative point in the coordinates of the sector's space. */
export function sectorPointInSpace(sector: SectorView, point: Point): Point {
  const origin = sectorOrigin(sector);
  return { x: origin.x + point.x, z: origin.z + point.z };
}
