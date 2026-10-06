import { buildSpaceCollision, neighbourSectors, resolveDoor, sectorAt } from '@somnio/core';
import type { ModelRegistry, Point, ResolvedDoor, SpaceCollision, WorldEntity } from '@somnio/core';
import type { Condition, NPCService, SectorView } from '@somnio/protocol';
import type { WorldRenderSurface } from './renderSurface';

/** An entity as the client holds it: where it is drawn, the body radius the server gave it, and how its health stands. */
export interface ClientEntity extends WorldEntity {
  radius: number;
  condition: Condition;
  /** What asking an NPC offers beyond its dialog. */
  service: NPCService | undefined;
}

/** A door of a held sector with its trigger resolved, addressed the way `useDoor` names it. */
export interface ClientDoor {
  sector: string;
  doorId: string;
  resolved: ResolvedDoor;
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

  constructor(spaceId: string, registry: ModelRegistry) {
    this.spaceId = spaceId;
    this.registry = registry;
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
        return resolved === undefined ? [] : [{ sector: held.name, doorId: door.id, resolved }];
      }),
    );
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
