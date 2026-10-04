import * as THREE from 'three';
import {
  EDGE_TOLERANCE,
  SOMNIO_CONSTANTS,
  distance,
  headingRadians,
  modelToWorld,
  objectModel,
  rectContains,
  resolveDoor,
  sectorOrigin,
  walkSurfaceLedges,
  worldToModel,
} from '@somnio/core';
import type { DoorAnchor, ModelRegistry, ObjectModelRule, Point, Rect, Sector, Size, Transform, WorldIssue } from '@somnio/core';
import type { Placement } from '@somnio/protocol';
import { placeholderFootprint } from '@/scene/placement';
import { byId, centeredRect, rectCorners, squareAround } from './selection';
import type { Footprint } from './selection';

/**
 * Flat unlit shapes for what the sector's records mean on the ground: the authored rects, each
 * placement's derived colliders, walk surfaces, ledges and door anchors, the door triggers and
 * arrival points, and the markers of NPCs and the spawn point. Over them come a border per
 * selected record, the resize/facing handles for a single selection, and the optional grid.
 *
 * Rebuilt from scratch on every update: the per-refresh cost is negligible at editor scale, and
 * diffing would couple the overlay to the sector's shape.
 *
 * **Rebuild on camera change, not only on document change**: the handle extents are
 * screen-constant points, so their world-space size changes with every zoom — the caller passes
 * them pre-converted and re-runs `update` on zoom and viewport resize.
 *
 * Nothing here is depth-tested: a collider lies inside the model it belongs to, so a tested
 * gizmo would be hidden by exactly the mesh it describes. The layers draw in `LAYER` order
 * instead.
 */

const LAYER = {
  floorPatches: 1,
  colliders: 2,
  walkSurfaces: 3,
  ledges: 4,
  doors: 5,
  spawns: 6,
  grid: 7,
  selection: 8,
  handles: 9,
} as const;

const LINE_THICKNESS = 0.04;
const GRID_LINE_OPACITY = 0.35;
/**
 * Record rects stay in the hundreds, but grid lines scale with sector size ÷ snap step —
 * past this cap the grid is skipped (at that density it is unreadable noise anyway).
 */
const MAX_GRID_LINES = 512;
/** Half the side of the square marking a door's arrival point. */
const ARRIVAL_MARKER_REACH = 0.1;
/** How far a door anchor's marker points out of the wall. */
const ANCHOR_MARKER_REACH = 0.3;

const COLOR = {
  issue: 0xff0000,
  blocking: 0xff00ff,
  walkSurface: 0x00c0ff,
  doorAnchor: 0xffa000,
  doorTrigger: 0x0000ff,
  doorArrival: 0x30b0c7,
  npc: 0x00ff00,
  spawnPoint: 0xffffff,
  monsterSpawn: 0xff8000,
  floorPatch: 0xc060ff,
  selection: 0xffff00,
  facing: 0x00ffff,
  grid: 0xffffff,
} as const;

export interface AuthoringHandleSet {
  centers: Point[];
  extent: number;
}

export interface AuthoringFacingHandle {
  center: Point;
  handle: Point;
  extent: number;
}

export interface AuthoringOverlayInput {
  sector: Sector;
  registry: ModelRegistry;
  /** What the world reports about this sector's records; each is drawn in red. */
  issues: readonly WorldIssue[];
  selection: Footprint[];
  resizeHandles?: AuthoringHandleSet | undefined;
  facingHandle?: AuthoringFacingHandle | undefined;
  showGrid: boolean;
  gridStep: number;
}

/** Text the canvas shows beside a record, at a sector-relative point. */
export interface OverlayLabel {
  text: string;
  at: Point;
  issue: boolean;
}

function hasIssue(issues: readonly WorldIssue[], record: WorldIssue['record'], id: string): boolean {
  return issues.some((issue) => issue.record === record && issue.id === id);
}

export class AuthoringOverlay {
  /** Added to the world scene once by the shell; contents are replaced per update. */
  readonly root = new THREE.Group();

  update(input: AuthoringOverlayInput): void {
    this.clear();
    const { sector, registry, issues } = input;
    // Everything below is sector-relative, as the records are.
    const origin = sectorOrigin(sector);
    this.root.position.set(origin.x, 0, origin.z);

    for (const patch of sector.floorPatches) this.root.add(filledRect(patch, COLOR.floorPatch, 0.2, LAYER.floorPatches));
    for (const blocker of sector.blockers) this.root.add(filledRect(blocker, COLOR.blocking, 0.3, LAYER.colliders));
    for (const placement of sector.placements) {
      const gizmo = placementGizmo(placement, objectModel(registry, placement.modelId), hasIssue(issues, 'placement', placement.id));
      if (gizmo !== undefined) this.root.add(gizmo);
    }
    for (const door of sector.doors) {
      const resolved = resolveDoor(sector, door, registry);
      const placement = byId(sector.placements, door.placement);
      const rule = placement === undefined ? undefined : objectModel(registry, placement.modelId);
      if (resolved === undefined || placement === undefined || rule === undefined) continue;
      const color = (regular: number): number => (hasIssue(issues, 'door', door.id) ? COLOR.issue : regular);
      // Both stand on the model's own ground: a door at the top of a stair has its trigger on the
      // landing and its arrival point wherever 0.8 m out from the wall falls.
      const arrival = worldToModel(resolved.transform, resolved.arrival);
      const gizmo = turned(placement);
      gizmo.add(
        filledRect(resolved.trigger, color(COLOR.doorTrigger), 0.3, LAYER.doors, surfaceHeight(rule, rectCenter(resolved.trigger))),
        filledRect(squareAround(arrival, ARRIVAL_MARKER_REACH), color(COLOR.doorArrival), 1, LAYER.doors, surfaceHeight(rule, arrival)),
      );
      this.root.add(gizmo);
    }
    for (const spawn of sector.monsterSpawns) this.root.add(filledRect(spawn, COLOR.monsterSpawn, 0.2, LAYER.spawns));
    for (const npc of sector.npcs) this.root.add(filledRect(squareAround(npc, SOMNIO_CONSTANTS.npcRadius), COLOR.npc, 0.4, LAYER.spawns));
    if (sector.spawn !== undefined) {
      this.root.add(filledRect(squareAround(sector.spawn, SOMNIO_CONSTANTS.playerRadius), COLOR.spawnPoint, 0.4, LAYER.spawns));
    }

    if (input.showGrid) {
      const grid = gridLines(sector.size, input.gridStep);
      if (grid !== undefined) this.root.add(grid);
    }

    for (const footprint of input.selection) {
      this.root.add(selectionBorder(footprint));
    }

    if (input.resizeHandles !== undefined) {
      this.root.add(resizeHandles(input.resizeHandles));
    }
    if (input.facingHandle !== undefined) {
      this.root.add(facingHandle(input.facingHandle));
    }
  }

  dispose(): void {
    this.clear();
    this.root.removeFromParent();
  }

  /**
   * Every plane here owns its geometry and material (no textures), so rebuild disposal is a
   * plain traverse — following `worldScene.ts`'s rule that a detached subtree releases what
   * it allocated.
   */
  private clear(): void {
    for (const child of [...this.root.children]) {
      child.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          material.dispose();
        }
      });
      this.root.remove(child);
    }
  }

  /** Test seam: how many gizmos the last update drew. */
  _childCount(): number {
    return this.root.children.length;
  }

  /** Test seam: the grid container's line count, or `undefined` when no grid is present. */
  _gridLineCount(): number | undefined {
    const grid = this.root.children.find((child) => child.name === GRID_NAME);
    return grid?.children.length;
  }
}

/**
 * The text labels of the records a shape alone does not identify: a door says where it leads,
 * an NPC who it is, a monster spawn what it keeps alive. A door with nothing to draw (its
 * placement's model has no such anchor) is labelled at the placement.
 */
export function overlayLabels(sector: Sector, registry: ModelRegistry, issues: readonly WorldIssue[]): OverlayLabel[] {
  return [
    ...sector.doors.flatMap((door): OverlayLabel[] => {
      const placement = byId(sector.placements, door.placement);
      if (placement === undefined) return [];
      const trigger = resolveDoor(sector, door, registry)?.trigger;
      return [
        {
          text: door.target.sector === '' ? `${door.id} -> no target sector` : `${door.id} -> ${door.target.sector}/${door.target.door}`,
          at: trigger === undefined ? { x: placement.x, z: placement.z } : modelToWorld(placement, rectCenter(trigger)),
          issue: trigger === undefined || hasIssue(issues, 'door', door.id),
        },
      ];
    }),
    ...sector.npcs.map((npc) => ({ text: npc.name === '' ? npc.id : npc.name, at: { x: npc.x, z: npc.z }, issue: false })),
    ...sector.monsterSpawns.map((spawn) => ({ text: `${spawn.kind} x${spawn.maxAlive}`, at: rectCenter(spawn), issue: false })),
  ];
}

const GRID_NAME = 'authoring-grid';

function rectCenter(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, z: rect.z + rect.depth / 2 };
}

/** An empty group standing where a placement does, so its children are positioned in model space. */
function turned(transform: Transform): THREE.Group {
  const group = new THREE.Group();
  group.position.set(transform.x, 0, transform.z);
  group.rotation.y = THREE.MathUtils.degToRad(transform.yaw);
  return group;
}

/**
 * What a placement's model does to movement: the colliders that block, the walk surfaces at
 * their heights, the ledges along them, and the anchors a door can be put at. A model the
 * registry does not know collides with nothing, so its placeholder's ground is drawn as the
 * issue it is. `undefined` for a model that neither blocks nor carries nor takes a door.
 */
function placementGizmo(placement: Placement, rule: ObjectModelRule | undefined, issue: boolean): THREE.Object3D | undefined {
  const gizmo = turned(placement);
  if (rule === undefined) {
    gizmo.add(filledRect(centeredRect(placeholderFootprint(rule)), COLOR.issue, 0.3, LAYER.colliders));
    return gizmo;
  }
  if (rule.colliders.length === 0 && rule.walkSurfaces.length === 0 && rule.doors.length === 0) return undefined;
  const color = (regular: number): number => (issue ? COLOR.issue : regular);
  for (const collider of rule.colliders) gizmo.add(filledRect(collider, color(COLOR.blocking), 0.2, LAYER.colliders));
  for (const surface of rule.walkSurfaces) gizmo.add(filledRect(surface, color(COLOR.walkSurface), 0.35, LAYER.walkSurfaces, surface.height));
  for (const ledge of walkSurfaceLedges(rule.walkSurfaces)) {
    // A ledge runs along the edge of the surface it is the drop from: the highest one touching it.
    const middle = { x: (ledge.a.x + ledge.b.x) / 2, z: (ledge.a.z + ledge.b.z) / 2 };
    gizmo.add(strip(ledge.a, ledge.b, color(COLOR.blocking), LAYER.ledges, surfaceHeight(rule, middle)));
  }
  for (const anchor of rule.doors) gizmo.add(anchorMarker(anchor, surfaceHeight(rule, anchor)));
  return gizmo;
}

/** How high the model's ground is at a model-space point: its highest walk surface there, else the floor. */
function surfaceHeight(rule: ObjectModelRule, point: Point): number {
  return Math.max(0, ...rule.walkSurfaces.filter((surface) => rectContains(surface, point, EDGE_TOLERANCE)).map((surface) => surface.height));
}

/**
 * Where a model can take a door, whether or not a door record uses it: a line across the opening
 * on the wall and a tick pointing the way the door opens, in model space and at the height of the
 * ground the door stands on.
 */
function anchorMarker(anchor: DoorAnchor, height: number): THREE.Object3D {
  const radians = headingRadians(anchor.facing);
  const out = { x: Math.sin(radians), z: Math.cos(radians) };
  const half = anchor.width / 2;
  const marker = new THREE.Group();
  marker.add(
    strip(
      { x: anchor.x - out.z * half, z: anchor.z + out.x * half },
      { x: anchor.x + out.z * half, z: anchor.z - out.x * half },
      COLOR.doorAnchor,
      LAYER.doors,
      height,
    ),
    strip(anchor, { x: anchor.x + out.x * ANCHOR_MARKER_REACH, z: anchor.z + out.z * ANCHOR_MARKER_REACH }, COLOR.doorAnchor, LAYER.doors, height),
  );
  return marker;
}

/**
 * Translucent unlit plane over a rect on the ground. Zero/negative extents (an invalidated
 * record mid-edit) yield an empty placeholder rather than a degenerate plane.
 */
function filledRect(rect: Rect, color: number, opacity: number, layer: number, height = 0): THREE.Object3D {
  return floorPlane(rectCenter(rect), rect, color, opacity, layer, height);
}

/** An opaque line on the ground from `a` to `b`. */
function strip(a: Point, b: Point, color: number, layer: number, height = 0): THREE.Object3D {
  const node = floorPlane({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }, { width: LINE_THICKNESS, depth: distance(a, b) }, color, 1, layer, height);
  node.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
  return node;
}

/** Four opaque yellow strips outlining the selected record's footprint — readable over the filled rect. */
function selectionBorder(footprint: Footprint): THREE.Object3D {
  const border = turned(footprint.transform);
  const corners = rectCorners(footprint.rect);
  corners.forEach((corner, index) => border.add(strip(corner, corners[(index + 1) % corners.length]!, COLOR.selection, LAYER.selection)));
  return border;
}

/** Small filled squares at the handle centers the drag layer computed. */
function resizeHandles(handles: AuthoringHandleSet): THREE.Object3D {
  const node = new THREE.Group();
  for (const center of handles.centers) {
    node.add(filledRect(squareAround(center, handles.extent / 2), COLOR.selection, 1, LAYER.handles));
  }
  return node;
}

/** The facing affordance: a tether strip plus a filled square at the handle. */
function facingHandle(handle: AuthoringFacingHandle): THREE.Object3D {
  const node = new THREE.Group();
  if (distance(handle.center, handle.handle) > 0) node.add(strip(handle.center, handle.handle, COLOR.facing, LAYER.handles));
  node.add(filledRect(squareAround(handle.handle, handle.extent / 2), COLOR.facing, 1, LAYER.handles));
  return node;
}

/**
 * `undefined` (no grid child at all) for degenerate inputs or when the line count would
 * exceed the cap, so overlay child counts stay meaningful around it.
 */
function gridLines(size: Size, step: number): THREE.Object3D | undefined {
  if (step <= 0 || size.width <= 0 || size.depth <= 0) return undefined;
  const columns = Math.floor(size.width / step + EDGE_TOLERANCE);
  const rows = Math.floor(size.depth / step + EDGE_TOLERANCE);
  if (columns + rows + 2 > MAX_GRID_LINES) return undefined;
  const grid = new THREE.Group();
  grid.name = GRID_NAME;
  for (let column = 0; column <= columns; column += 1) {
    grid.add(floorPlane({ x: column * step, z: size.depth / 2 }, { width: LINE_THICKNESS, depth: size.depth }, COLOR.grid, GRID_LINE_OPACITY, LAYER.grid));
  }
  for (let row = 0; row <= rows; row += 1) {
    grid.add(floorPlane({ x: size.width / 2, z: row * step }, { width: size.width, depth: LINE_THICKNESS }, COLOR.grid, GRID_LINE_OPACITY, LAYER.grid));
  }
  return grid;
}

/**
 * A flat quad at the given center, `height` above the floor. Parent group carries position and
 * (for a strip) the yaw; the child mesh carries only the lie-flat rotation, so the two rotations
 * compose without Euler-order surprises. Tone-mapping off: selection yellow against facing cyan
 * is a meaning-carrying distinction, not scene luminance.
 */
function floorPlane(center: Point, size: Size, color: number, opacity: number, layer: number, height = 0): THREE.Object3D {
  const group = new THREE.Group();
  if (size.width <= 0 || size.depth <= 0) return group;
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    toneMapped: false,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size.width, size.depth), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = layer;
  group.add(mesh);
  group.position.set(center.x, height, center.z);
  return group;
}
