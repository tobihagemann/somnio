import type { Fixture, SectorView, Service } from '@somnio/protocol';
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
  service?: Service;
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
  /** The chance, from 0 to 1, that a monster it spawns is an elite. */
  eliteChance: number;
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
    ground: sector.ground,
    placements: sector.placements,
    blockers: sector.blockers,
    doors: sector.doors,
    fixtures: sector.fixtures,
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

/** The entity id an NPC of the sector goes by, on the wire and as a quest's carrier. */
export function npcEntityId(sectorName: string, npcId: string): string {
  return `npc:${sectorName}/${npcId}`;
}

/** The id a fixture of the sector goes by as a service carrier, on the wire and in `quests.json`. A fixture is never an entity. */
export function fixtureCarrierId(sectorName: string, fixtureId: string): string {
  return `fixture:${sectorName}/${fixtureId}`;
}

/** A fixture by its carrier id, standing at its placement's centre in the coordinates of its sector's space. */
export interface PlacedFixture {
  id: string;
  sector: string;
  fixture: Fixture;
  position: Point;
}

/** The sector's fixtures where they stand. The decoder holds each to a placement of the sector. */
export function placedFixtures(sector: SectorView): PlacedFixture[] {
  return sector.fixtures.flatMap((fixture) => {
    const placement = sector.placements.find((candidate) => candidate.id === fixture.placement);
    if (placement === undefined) return [];
    return [{ id: fixtureCarrierId(sector.name, fixture.id), sector: sector.name, fixture, position: sectorPointInSpace(sector, placement) }];
  });
}

/** A sector-relative point in the coordinates of the sector's space. */
export function sectorPointInSpace(sector: SectorView, point: Point): Point {
  const origin = sectorOrigin(sector);
  return { x: origin.x + point.x, z: origin.z + point.z };
}

/** A monster spawn's area in the coordinates of its sector's space: the home ground its monsters keep to. */
export function spawnArea(sector: SectorView, spawn: MonsterSpawn): Rect {
  return { ...sectorPointInSpace(sector, spawn), width: spawn.width, depth: spawn.depth };
}
