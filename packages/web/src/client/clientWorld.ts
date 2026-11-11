import { buildSpaceCollision, findPath, neighbourSectors, resolveDoor, sectorAt, walkRasterInputs } from '@somnio/core';
import type { AbilityBody, Body, EngageTarget, FoundPath, ModelRegistry, Point, ResolvedDoor, SpaceCollision, WalkRaster, WorldEntity } from '@somnio/core';
import type { Condition, Held, NPCService, SectorView } from '@somnio/protocol';
import type { WorldRenderSurface } from './renderSurface';
import { defaultWalkRasterizer } from './walkRasterizer';
import type { WalkRasterizer } from './walkRasterizer';

/** An entity as the client holds it: where it is drawn, the body radius the server gave it, and how its health stands. */
export interface ClientEntity extends WorldEntity {
  radius: number;
  condition: Condition;
  /** What asking an NPC offers beyond its dialog. */
  service: NPCService | undefined;
  /** What a dreamer's hands hold. */
  held: Held | undefined;
}

/** Whether the entity is a nightmare driven off: fading, it is nothing to face, act on, or walk round. */
export function drivenOff(entity: Pick<ClientEntity, 'kind' | 'condition'>): boolean {
  return entity.kind === 'monster' && entity.condition === 'fallen';
}

/** What the entity is to slot 1: a nightmare not yet driven off, a dreamer, or nothing. */
export function engageKind(entity: Pick<ClientEntity, 'kind' | 'condition'>): EngageTarget | undefined {
  if (entity.kind === 'npc' || drivenOff(entity)) return undefined;
  return entity.kind === 'monster' ? 'nightmare' : 'dreamer';
}

/** The body as an ability's rules see it, standing `at`. */
export function abilityBody(body: Pick<ClientEntity, 'kind' | 'condition' | 'radius'>, at: Point): AbilityBody {
  return { x: at.x, z: at.z, radius: body.radius, kind: engageKind(body), fallen: body.condition === 'fallen' };
}

/** A door of a held sector with its trigger resolved, addressed the way `useDoor` names it. */
export interface ClientDoor {
  sector: string;
  doorId: string;
  resolved: ResolvedDoor;
  nightOnly: boolean;
}

/**
 * The space the client stands in: every sector received since `enterSpace`, and the collision
 * built from all of them.
 *
 * Sector data is never dropped. The predicted sector can differ from the one the server accepted
 * (a dip across a border between two reports, or a rejected crossing), and the server sends a
 * sector again only on an accepted change, so evicting one here would leave a border that blocks.
 * What follows the predicted position is the draw set: the predicted sector plus its neighbours.
 */
export class ClientWorld {
  readonly spaceId: string;
  /** Rebuilt whenever a sector arrives. */
  collision: SpaceCollision;
  doors: ClientDoor[] = [];
  /** The sector the predicted position was last found in. */
  predictedSector: string | undefined;

  private readonly registry: ModelRegistry;
  private readonly sectors: SectorView[] = [];
  private readonly drawn = new Set<string>();
  private readonly walkRasterizer: WalkRasterizer;
  /** Each sector's walk raster, kept until the raster for its current inputs replaces it. */
  private readonly walkRasters = new Map<string, WalkRaster>();
  /** The raster each sector waits for; one asked for earlier is stale when it arrives. */
  private readonly walkGenerations = new Map<string, number>();
  private walkGeneration = 0;

  constructor(spaceId: string, registry: ModelRegistry, walkRasterizer: WalkRasterizer = defaultWalkRasterizer()) {
    this.spaceId = spaceId;
    this.registry = registry;
    this.walkRasterizer = walkRasterizer;
    this.collision = buildSpaceCollision({ id: spaceId, sectors: this.sectors }, registry);
  }

  addSector(sector: SectorView): void {
    const index = this.sectors.findIndex((held) => held.name === sector.name);
    if (index === -1) this.sectors.push(sector);
    else this.sectors[index] = sector;
    this.collision = buildSpaceCollision({ id: this.spaceId, sectors: this.sectors }, this.registry);
    this.doors = this.sectors.flatMap((held) =>
      held.doors.flatMap((door) => {
        const resolved = resolveDoor(held, door, this.registry);
        return resolved === undefined ? [] : [{ sector: held.name, doorId: door.id, resolved, nightOnly: door.nightOnly === true }];
      }),
    );
    // A sector edge with no held neighbour blocks, so the sectors touching this one walk differently now too.
    this.rasterizeWalkable(sector);
    for (const neighbour of neighbourSectors({ id: this.spaceId, sectors: this.sectors }, sector.name)) this.rasterizeWalkable(neighbour);
  }

  /**
   * A path from `from` toward `to` round the held sectors' static world and `bodies`, over the walk
   * rasters computed so far. `excludedEdges` is the walk's: the search adds to it, and every re-plan
   * of one walk passes the same set.
   */
  findPath(from: Point, to: Point, bodies: readonly Body[], excludedEdges: Set<string>): FoundPath {
    return findPath({ collision: this.collision, rasters: this.walkRasters.values() }, from, to, bodies, excludedEdges);
  }

  private rasterizeWalkable(sector: SectorView): void {
    this.walkGeneration += 1;
    const generation = this.walkGeneration;
    this.walkGenerations.set(sector.name, generation);
    this.walkRasterizer.rasterize(walkRasterInputs(this.collision, sector), (raster) => {
      if (this.walkGenerations.get(sector.name) === generation) this.walkRasters.set(sector.name, raster);
    });
  }

  /**
   * Moves the draw set to the sector holding `point` and its neighbours, adding and removing
   * sectors on the surface. A point no held sector covers leaves the draw set as it is.
   */
  follow(point: Point, surface: Pick<WorldRenderSurface, 'addSector' | 'removeSector'>): void {
    const space = { id: this.spaceId, sectors: this.sectors };
    const predicted = sectorAt(space, point);
    if (predicted === undefined) return;
    this.predictedSector = predicted.name;
    const wanted = [predicted, ...neighbourSectors(space, predicted.name)];
    const names = new Set(wanted.map((sector) => sector.name));
    for (const name of [...this.drawn]) {
      if (names.has(name)) continue;
      this.drawn.delete(name);
      surface.removeSector(name);
    }
    for (const sector of wanted) {
      if (this.drawn.has(sector.name)) continue;
      this.drawn.add(sector.name);
      surface.addSector(sector);
    }
  }
}
