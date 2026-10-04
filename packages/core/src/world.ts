import type { Door, SectorView } from '@somnio/protocol';
import { buildSpaceCollision, canStand, npcBodies } from './collision.ts';
import { SOMNIO_CONSTANTS } from './constants.ts';
import { EDGE_TOLERANCE, modelToWorld, rectContains, rectsOverlap, worldToModel } from './geometry.ts';
import type { Point, Rect, Transform } from './geometry.ts';
import { heading, headingRadians } from './heading.ts';
import type { Heading } from './heading.ts';
import { objectModel } from './modelRegistry.ts';
import type { ModelRegistry } from './modelRegistry.ts';
import { sectorPointInSpace, sectorRect } from './sector.ts';
import type { Sector } from './sector.ts';

/**
 * The world as spaces: every outdoor sector lies in one continuous space at its `origin`, and
 * each interior is a space of its own. Bodies walk freely within a space and change space only
 * through a door.
 */

export const OUTDOOR_SPACE_ID = 'outdoors';

/** How far out from its anchor, along its facing, a door puts an arriving body: beyond the trigger. */
const DOOR_ARRIVAL_OFFSET = 0.8;

export interface Space<S extends SectorView = SectorView> {
  id: string;
  sectors: S[];
}

/** A content mistake that leaves the world loadable, pinned to the record that carries it. */
export interface WorldIssue {
  sector: string;
  record: 'placement' | 'door';
  id: string;
  message: string;
}

export interface World {
  spaces: Map<string, Space<Sector>>;
  /** Sector name to the id of the space holding it. */
  sectorSpace: Map<string, string>;
  /** Every door reported here is inert: the sectors in `spaces` no longer carry it. */
  issues: WorldIssue[];
}

/** A world that cannot be served at all. */
export class WorldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorldError';
  }
}

/**
 * Groups the sectors into spaces and proves what a join relies on. Throws on outdoor sectors that
 * overlap, an outdoor sector smaller than `minOutdoorSectorExtent`, a sector named like the
 * outdoor space, and a `spawn` a body cannot stand on. A door is live only as half of a sound
 * pair: both doors resolve, point at each other, and have an arrival point a body can stand on.
 * Any other door is reported and dropped from its sector. The collision issues of each space are
 * reported too. Standing means clear of colliders, blockers, ledges, and the space's NPCs.
 */
export function buildWorld(sectors: readonly Sector[], registry: ModelRegistry): World {
  const outdoor = sectors.filter((sector) => sector.kind === 'outdoor');
  for (const sector of sectors) {
    if (sector.name === OUTDOOR_SPACE_ID) throw new WorldError(`a sector cannot be named "${OUTDOOR_SPACE_ID}"`);
  }
  outdoor.forEach((sector, index) => {
    if (Math.min(sector.size.width, sector.size.depth) < SOMNIO_CONSTANTS.minOutdoorSectorExtent) {
      throw new WorldError(`outdoor sector ${sector.name} is smaller than ${SOMNIO_CONSTANTS.minOutdoorSectorExtent} metres`);
    }
    const overlapped = outdoor.slice(index + 1).find((other) => rectsOverlap(sectorRect(sector), sectorRect(other)));
    if (overlapped !== undefined) throw new WorldError(`outdoor sectors ${sector.name} and ${overlapped.name} overlap`);
  });

  const groups: Space<Sector>[] = [
    ...(outdoor.length === 0 ? [] : [{ id: OUTDOOR_SPACE_ID, sectors: outdoor }]),
    ...sectors.filter((sector) => sector.kind === 'interior').map((sector) => ({ id: sector.name, sectors: [sector] })),
  ];
  const standsIn = new Map<string, (point: Point) => boolean>();
  const issues: WorldIssue[] = [];
  for (const space of groups) {
    const collision = buildSpaceCollision(space, registry);
    issues.push(...collision.issues);
    const npcs = npcBodies(space);
    const stands = (point: Point): boolean => canStand(collision, point, npcs);
    for (const sector of space.sectors) standsIn.set(sector.name, stands);
  }

  for (const sector of sectors) {
    if (sector.spawn === undefined) continue;
    if (!standsIn.get(sector.name)!(sectorPointInSpace(sector, sector.spawn))) {
      throw new WorldError(`the spawn of sector ${sector.name} at (${sector.spawn.x}, ${sector.spawn.z}) is not clear`);
    }
  }

  const byName = new Map(sectors.map((sector) => [sector.name, sector]));
  const unsound = new Map<Door, string>();
  for (const sector of sectors) {
    for (const door of sector.doors) {
      const resolved = resolveDoor(sector, door, registry);
      if (resolved === undefined) {
        unsound.set(door, `placement "${door.placement}" has no door anchor "${door.anchor}"`);
      } else if (!standsIn.get(sector.name)!(resolved.arrival)) {
        unsound.set(door, `the arrival point (${resolved.arrival.x.toFixed(2)}, ${resolved.arrival.z.toFixed(2)}) is not clear`);
      }
    }
  }
  const inert = new Set<Door>();
  for (const sector of sectors) {
    for (const door of sector.doors) {
      const targetName = `"${door.target.door}" in ${door.target.sector}`;
      const target = byName.get(door.target.sector)?.doors.find((candidate) => candidate.id === door.target.door);
      let message = unsound.get(door);
      if (message === undefined) {
        if (target === undefined) message = `target door ${targetName} does not exist`;
        else if (target.target.sector !== sector.name || target.target.door !== door.id) message = `target door ${targetName} does not point back`;
        else if (unsound.has(target)) message = `target door ${targetName} is inert`;
      }
      if (message === undefined) continue;
      inert.add(door);
      issues.push({ sector: sector.name, record: 'door', id: door.id, message });
    }
  }

  const spaces = new Map<string, Space<Sector>>();
  const sectorSpace = new Map<string, string>();
  for (const space of groups) {
    spaces.set(space.id, { id: space.id, sectors: space.sectors.map((sector) => ({ ...sector, doors: sector.doors.filter((door) => !inert.has(door)) })) });
    for (const sector of space.sectors) sectorSpace.set(sector.name, space.id);
  }
  return { spaces, sectorSpace, issues };
}

/** The sector whose ground holds the point, in the space's coordinates. */
export function sectorAt<S extends SectorView>(space: Space<S>, point: Point): S | undefined {
  return space.sectors.find((sector) => rectContains(sectorRect(sector), point, EDGE_TOLERANCE));
}

/** The sectors whose ground touches the named sector's, along an edge or at a corner. */
export function neighbourSectors<S extends SectorView>(space: Space<S>, sectorName: string): S[] {
  const sector = space.sectors.find((candidate) => candidate.name === sectorName);
  if (sector === undefined) return [];
  const rect = sectorRect(sector);
  return space.sectors.filter((candidate) => {
    const other = sectorRect(candidate);
    return (
      candidate !== sector &&
      other.x - (rect.x + rect.width) <= EDGE_TOLERANCE &&
      rect.x - (other.x + other.width) <= EDGE_TOLERANCE &&
      other.z - (rect.z + rect.depth) <= EDGE_TOLERANCE &&
      rect.z - (other.z + other.depth) <= EDGE_TOLERANCE
    );
  });
}

export interface ResolvedDoor {
  /** Where a body coming out of the door stands, in the space's coordinates. */
  arrival: Point;
  /** The heading out of the door, which an arriving body faces. */
  facing: Heading;
  /** Where the door's placement stands in the space. */
  transform: Transform;
  /** The ground in front of the door that uses it, in the placement's model space. */
  trigger: Rect;
}

/** `undefined` when the door's placement is missing, its model is not in the registry, or the model has no such anchor. */
export function resolveDoor(sector: SectorView, door: Door, registry: ModelRegistry): ResolvedDoor | undefined {
  const placement = sector.placements.find((candidate) => candidate.id === door.placement);
  if (placement === undefined) return undefined;
  const anchor = objectModel(registry, placement.modelId)?.doors.find((candidate) => candidate.id === door.anchor);
  if (anchor === undefined) return undefined;
  const transform = { ...sectorPointInSpace(sector, placement), yaw: placement.yaw };
  const radians = headingRadians(anchor.facing);
  const out = { x: Math.round(Math.sin(radians)), z: Math.round(Math.cos(radians)) };
  const depth = SOMNIO_CONSTANTS.doorTriggerDepth;
  const reach = { x: out.x * depth, z: out.z * depth };
  const across = { x: (Math.abs(out.z) * anchor.width) / 2, z: (Math.abs(out.x) * anchor.width) / 2 };
  return {
    arrival: modelToWorld(transform, { x: anchor.x + out.x * DOOR_ARRIVAL_OFFSET, z: anchor.z + out.z * DOOR_ARRIVAL_OFFSET }),
    facing: heading(anchor.facing + placement.yaw),
    transform,
    trigger: {
      x: anchor.x - across.x + Math.min(0, reach.x),
      z: anchor.z - across.z + Math.min(0, reach.z),
      width: 2 * across.x + Math.abs(reach.x),
      depth: 2 * across.z + Math.abs(reach.z),
    },
  };
}

/** Whether the point stands in the door's trigger, widened by `slack` on every side. */
export function doorContains(resolved: ResolvedDoor, point: Point, slack: number): boolean {
  return rectContains(resolved.trigger, worldToModel(resolved.transform, point), slack);
}
