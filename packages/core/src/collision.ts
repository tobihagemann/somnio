import { SOMNIO_CONSTANTS } from './constants.ts';
import { EDGE_TOLERANCE, clamp, distance, modelToWorld, rectContains, worldToModel } from './geometry.ts';
import type { Point, Rect, Segment, Transform } from './geometry.ts';
import { objectModel } from './modelRegistry.ts';
import type { ModelRegistry, ObjectModelRule, WalkSurface } from './modelRegistry.ts';
import { sectorOrigin, sectorPointInSpace, sectorRect } from './sector.ts';
import type { Sector } from './sector.ts';
import type { Space, WorldIssue } from './world.ts';

/**
 * Collision and ground height for one space. The client's predictor and the server's movement
 * check both run on this module over the same sectors and registry, so the two judge a move by
 * the same rule. A client whose reports arrive in time is therefore never corrected. A divergence
 * here shows up as the server rejecting moves the client already drew.
 *
 * A placement is evaluated in its model's space: the point is taken through the placement's
 * inverse position and yaw and tested against the registry's axis-aligned rects there, so any
 * yaw works.
 */

/** The longest stretch a move is checked or taken in one piece. */
export const MOVE_SUBSTEP = 0.05;

/** A distance this close to a radius is contact, and contact is clear, so a slide along a wall does not stick. */
const CONTACT_TOLERANCE = 1e-6;

/** Something round that stands in the way: an NPC, or a player or monster as the client draws it. */
export interface Body extends Point {
  radius: number;
}

/** One placement's collision geometry, in its model's space. */
export interface PlacedModel {
  sector: string;
  placement: string;
  /** Where the model stands in the space. */
  transform: Transform;
  /** How far from the model's origin its geometry reaches. */
  reach: number;
  colliders: readonly Rect[];
  walkSurfaces: readonly WalkSurface[];
  ledges: readonly Segment[];
}

export interface SpaceCollision {
  /** The walkable area is the union of these. */
  sectors: Rect[];
  /** The stretches of sector edge with no neighbouring sector, which block. */
  edges: Segment[];
  blockers: Rect[];
  models: PlacedModel[];
  /** What the space's content gets wrong; none of it stops the space from loading. */
  issues: WorldIssue[];
}

export function buildSpaceCollision(space: Space, registry: ModelRegistry): SpaceCollision {
  const sectors = space.sectors.map(sectorRect);
  const blockers: Rect[] = [];
  const models: PlacedModel[] = [];
  const issues: WorldIssue[] = [];
  const geometries = new Map<ObjectModelRule, Pick<PlacedModel, 'reach' | 'ledges'>>();
  for (const sector of space.sectors) {
    const origin = sectorOrigin(sector);
    for (const blocker of sector.blockers) {
      blockers.push({ x: origin.x + blocker.x, z: origin.z + blocker.z, width: blocker.width, depth: blocker.depth });
    }
    for (const placement of sector.placements) {
      const rule = objectModel(registry, placement.modelId);
      if (rule === undefined) {
        issues.push(placementIssue(sector.name, placement.id, `model "${placement.modelId}" is not in the registry, so it does not collide`));
        continue;
      }
      if (rule.colliders.length === 0 && rule.walkSurfaces.length === 0) continue;
      if (placement.elevation !== 0 && rule.walkSurfaces.length > 0) {
        issues.push(placementIssue(sector.name, placement.id, `elevation ${placement.elevation} is ignored: model "${rule.id}" has walk surfaces`));
      }
      let geometry = geometries.get(rule);
      if (geometry === undefined) {
        geometry = { reach: modelReach(rule), ledges: walkSurfaceLedges(rule.walkSurfaces) };
        geometries.set(rule, geometry);
      }
      models.push({
        sector: sector.name,
        placement: placement.id,
        transform: { x: origin.x + placement.x, z: origin.z + placement.z, yaw: placement.yaw },
        colliders: rule.colliders,
        walkSurfaces: rule.walkSurfaces,
        ...geometry,
      });
    }
  }
  models.forEach((model, index) => {
    for (const other of models.slice(index + 1)) {
      if (!walkSurfacesOverlap(model, other)) continue;
      issues.push(placementIssue(model.sector, model.placement, `walk surfaces overlap those of "${other.placement}" in ${other.sector}`));
      issues.push(placementIssue(other.sector, other.placement, `walk surfaces overlap those of "${model.placement}" in ${model.sector}`));
    }
  });
  return { sectors, edges: sectors.flatMap((rect) => openEdges(rect, sectors, () => true)), blockers, models, issues };
}

function placementIssue(sector: string, id: string, message: string): WorldIssue {
  return { sector, record: 'placement', id, message };
}

function modelReach(rule: ObjectModelRule): number {
  let reach = 0;
  for (const rect of [...rule.colliders, ...rule.walkSurfaces]) {
    reach = Math.max(reach, Math.hypot(Math.max(Math.abs(rect.x), Math.abs(rect.x + rect.width)), Math.max(Math.abs(rect.z), Math.abs(rect.z + rect.depth))));
  }
  return reach;
}

/**
 * The ledges of one model: every stretch of a walk surface's edge where the ground beyond lies
 * more than the step height below it. They block like walls, so a body neither hangs over a porch
 * edge nor sinks into the plinth from the ground side. The ground beyond is the adjoining walk
 * surface of the same model, else the floor.
 */
export function walkSurfaceLedges(surfaces: readonly WalkSurface[]): Segment[] {
  return surfaces
    .filter((surface) => surface.height > SOMNIO_CONSTANTS.maxStepHeight)
    .flatMap((surface) => openEdges(surface, surfaces, (other) => surface.height - other.height <= SOMNIO_CONSTANTS.maxStepHeight));
}

/**
 * The stretches of a rect's four edges that no other rect passing `joins` adjoins from outside.
 * Segment ends come from the rects' own edges, never from sampling: an end off by a centimetre
 * leaves a corner a sliding body wedges in.
 */
function openEdges<R extends Rect>(rect: R, others: readonly R[], joins: (other: R) => boolean): Segment[] {
  const maxX = rect.x + rect.width;
  const maxZ = rect.z + rect.depth;
  const neighbours = others.filter((other) => other !== rect && joins(other));
  const segments: Segment[] = [];
  const edge = (gap: (other: R) => number, span: (other: R) => [number, number], from: number, to: number, at: (along: number) => Point): void => {
    const covers = neighbours.filter((other) => Math.abs(gap(other)) <= EDGE_TOLERANCE).map(span);
    for (const [start, end] of uncovered(from, to, covers)) segments.push({ a: at(start), b: at(end) });
  };
  const spanX = (other: R): [number, number] => [other.x, other.x + other.width];
  const spanZ = (other: R): [number, number] => [other.z, other.z + other.depth];
  edge(
    (other) => other.z + other.depth - rect.z,
    spanX,
    rect.x,
    maxX,
    (x) => ({ x, z: rect.z }),
  );
  edge(
    (other) => other.z - maxZ,
    spanX,
    rect.x,
    maxX,
    (x) => ({ x, z: maxZ }),
  );
  edge(
    (other) => other.x + other.width - rect.x,
    spanZ,
    rect.z,
    maxZ,
    (z) => ({ x: rect.x, z }),
  );
  edge(
    (other) => other.x - maxX,
    spanZ,
    rect.z,
    maxZ,
    (z) => ({ x: maxX, z }),
  );
  return segments;
}

/** The stretches of `[from, to]` no cover reaches. A stretch within `EDGE_TOLERANCE` is rounding, not a gap. */
function uncovered(from: number, to: number, covers: readonly [number, number][]): [number, number][] {
  const gaps: [number, number][] = [];
  let cursor = from;
  for (const [start, end] of covers.toSorted((a, b) => a[0] - b[0])) {
    if (end <= cursor || start >= to) continue;
    if (start - cursor > EDGE_TOLERANCE) gaps.push([cursor, start]);
    cursor = end;
  }
  if (to - cursor > EDGE_TOLERANCE) gaps.push([cursor, to]);
  return gaps;
}

/** Walk surfaces of two placements sharing ground. Oriented rects, so the test is a separating-axis one. */
function walkSurfacesOverlap(a: PlacedModel, b: PlacedModel): boolean {
  if (a.walkSurfaces.length === 0 || b.walkSurfaces.length === 0 || distance(a.transform, b.transform) > a.reach + b.reach) return false;
  const quads = (model: PlacedModel): Point[][] => model.walkSurfaces.map((surface) => corners(surface).map((corner) => modelToWorld(model.transform, corner)));
  const others = quads(b);
  return quads(a).some((quad) => others.some((other) => quadsOverlap(quad, other)));
}

function corners(rect: Rect): Point[] {
  return [
    { x: rect.x, z: rect.z },
    { x: rect.x + rect.width, z: rect.z },
    { x: rect.x + rect.width, z: rect.z + rect.depth },
    { x: rect.x, z: rect.z + rect.depth },
  ];
}

function quadsOverlap(a: readonly Point[], b: readonly Point[]): boolean {
  for (const quad of [a, b]) {
    for (const index of [0, 1]) {
      const from = quad[index]!;
      const to = quad[index + 1]!;
      const length = distance(from, to);
      const along = (point: Point): number => ((point.x - from.x) * (to.x - from.x) + (point.z - from.z) * (to.z - from.z)) / length;
      const spanA = a.map(along);
      const spanB = b.map(along);
      if (Math.min(Math.max(...spanA), Math.max(...spanB)) - Math.max(Math.min(...spanA), Math.min(...spanB)) <= EDGE_TOLERANCE) return false;
    }
  }
  return true;
}

function distanceToRect(point: Point, rect: Rect): number {
  return distance(point, { x: clamp(point.x, rect.x, rect.x + rect.width), z: clamp(point.z, rect.z, rect.z + rect.depth) });
}

function distanceToSegment(point: Point, segment: Segment): number {
  const dx = segment.b.x - segment.a.x;
  const dz = segment.b.z - segment.a.z;
  const lengthSquared = dx * dx + dz * dz;
  const along = lengthSquared === 0 ? 0 : clamp(((point.x - segment.a.x) * dx + (point.z - segment.a.z) * dz) / lengthSquared, 0, 1);
  return distance(point, { x: segment.a.x + dx * along, z: segment.a.z + dz * along });
}

/** True when a circle of `radius` centred on the point lies inside the space and touches no blocker, collider, or ledge. */
export function isClear(collision: SpaceCollision, point: Point, radius: number): boolean {
  if (!collision.sectors.some((rect) => rectContains(rect, point, EDGE_TOLERANCE))) return false;
  const reach = radius - CONTACT_TOLERANCE;
  if (collision.edges.some((edge) => distanceToSegment(point, edge) < reach)) return false;
  if (collision.blockers.some((rect) => distanceToRect(point, rect) < reach)) return false;
  for (const model of collision.models) {
    if (distance(point, model.transform) > model.reach + radius) continue;
    const local = worldToModel(model.transform, point);
    if (model.colliders.some((rect) => distanceToRect(local, rect) < reach)) return false;
    if (model.ledges.some((ledge) => distanceToSegment(local, ledge) < reach)) return false;
  }
  return true;
}

/**
 * The height of the walk surface under the point, else 0. Where surfaces of two placements
 * overlap the higher one wins, so the result never depends on record order.
 */
export function groundHeightAt(collision: SpaceCollision, point: Point): number {
  let height = 0;
  for (const model of collision.models) {
    if (model.walkSurfaces.length === 0 || distance(point, model.transform) > model.reach + EDGE_TOLERANCE) continue;
    const local = worldToModel(model.transform, point);
    for (const surface of model.walkSurfaces) {
      if (surface.height > height && rectContains(surface, local, EDGE_TOLERANCE)) height = surface.height;
    }
  }
  return height;
}

function touches(point: Point, radius: number, bodies: readonly Body[]): boolean {
  return bodies.some((body) => distance(point, body) < radius + body.radius - CONTACT_TOLERANCE);
}

/**
 * Whether another body stops a step. It does at contact, unless the step does not bring
 * the two centres closer, so an overlapping pair can always separate.
 */
export function bodyBlocks(from: Point, to: Point, radius: number, body: Body): boolean {
  const after = distance(to, body);
  return after < radius + body.radius - CONTACT_TOLERANCE && after < distance(from, body);
}

/**
 * The movement rule both sides share: the server judges a reported move with this, and the client
 * never reports a move this refuses. The endpoint is tested at the full radius. The path is
 * sampled every `MOVE_SUBSTEP` at the radius less `pathTolerance`, which is the sag of a chord
 * between two positions on a rounded corner. No step between two samples may be higher than
 * `maxStepHeight`. NPCs never move, so they block here too; other players and monsters do not.
 */
export function isLegalMove(collision: SpaceCollision, from: Point, to: Point, radius: number, npcs: readonly Body[]): boolean {
  if (!isClear(collision, to, radius) || touches(to, radius, npcs)) return false;
  const pathRadius = radius - SOMNIO_CONSTANTS.pathTolerance;
  const count = Math.max(1, Math.ceil(distance(from, to) / MOVE_SUBSTEP));
  let height = groundHeightAt(collision, from);
  for (let index = 1; index <= count; index += 1) {
    const sample = index === count ? to : { x: from.x + ((to.x - from.x) * index) / count, z: from.z + ((to.z - from.z) * index) / count };
    if (index < count && (!isClear(collision, sample, pathRadius) || touches(sample, pathRadius, npcs))) return false;
    const next = groundHeightAt(collision, sample);
    if (Math.abs(next - height) > SOMNIO_CONSTANTS.maxStepHeight) return false;
    height = next;
  }
  return true;
}

/** The space's NPCs as the bodies a move is checked against. */
export function npcBodies(space: Space<Sector>): Body[] {
  return space.sectors.flatMap((sector) => sector.npcs.map((npc) => ({ ...sectorPointInSpace(sector, npc), radius: SOMNIO_CONSTANTS.npcRadius })));
}

/**
 * Whether a player can stand at the point: a move ending there is legal, so it is clear of the
 * static world and of every NPC. A body arriving in contact with an NPC could never move again.
 */
export function canStand(collision: SpaceCollision, point: Point, npcs: readonly Body[]): boolean {
  return isLegalMove(collision, point, point, SOMNIO_CONSTANTS.playerRadius, npcs);
}

export interface ResolvedMove {
  position: Point;
  /** The move was cut short or turned into a slide. */
  blocked: boolean;
}

/**
 * The client's step from `from` toward `to`, in substeps of at most `MOVE_SUBSTEP`: the full
 * substep where it is legal, else a slide along one axis, else a stop. `bodies` are the other
 * players and monsters at the positions the client draws them.
 */
export function resolveMove(collision: SpaceCollision, from: Point, to: Point, radius: number, npcs: readonly Body[], bodies: readonly Body[]): ResolvedMove {
  const substeps = Math.max(1, Math.ceil(distance(from, to) / MOVE_SUBSTEP));
  const stepX = (to.x - from.x) / substeps;
  const stepZ = (to.z - from.z) / substeps;
  let position = from;
  let blocked = false;
  const legal = (next: Point): boolean =>
    isLegalMove(collision, position, next, radius, npcs) && !bodies.some((body) => bodyBlocks(position, next, radius, body));
  for (let index = 0; index < substeps; index += 1) {
    const full = { x: position.x + stepX, z: position.z + stepZ };
    const alongX = { x: position.x + stepX, z: position.z };
    const alongZ = { x: position.x, z: position.z + stepZ };
    if (legal(full)) {
      position = full;
      continue;
    }
    blocked = true;
    if (stepX !== 0 && legal(alongX)) position = alongX;
    else if (stepZ !== 0 && legal(alongZ)) position = alongZ;
    else break;
  }
  return { position, blocked };
}
