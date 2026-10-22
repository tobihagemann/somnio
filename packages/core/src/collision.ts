import { SOMNIO_CONSTANTS } from './constants.ts';
import { EDGE_TOLERANCE, clamp, closestOnRect, closestOnSegment, distance, distanceToRect, modelToWorld, rectContains, worldToModel } from './geometry.ts';
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

/** How far a glide may still lean into a face that refused its step: rounding residue, not a push into a wedge. */
const WEDGE_TOLERANCE = 1e-9;

/** A glide shorter than this is what clipping leaves of a head-on step, and would only creep. */
const NEGLIGIBLE_GLIDE = 1e-4;

/** Rounding in a sum or a turn, per metre from the origin: how far a point or a face may miss a face's line and still lie on it. */
const FACE_ROUNDOFF = 128 * Number.EPSILON;

/** Something round that stands in the way: an NPC, a player, or a monster. */
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
  // Each placement is reported once, naming the first it overlaps, so the issues grow with the placements and not with their pairs.
  const reported = new Set<PlacedModel>();
  models.forEach((model, index) => {
    for (let next = index + 1; next < models.length; next += 1) {
      const other = models[next]!;
      if ((reported.has(model) && reported.has(other)) || !walkSurfacesOverlap(model, other)) continue;
      for (const [placed, overlapped] of [
        [model, other],
        [other, model],
      ] as const) {
        if (reported.has(placed)) continue;
        reported.add(placed);
        issues.push(placementIssue(placed.sector, placed.placement, `walk surfaces overlap those of "${overlapped.placement}" in ${overlapped.sector}`));
      }
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

function distanceToSegment(point: Point, segment: Segment): number {
  return distance(point, closestOnSegment(point, segment));
}

/** A stretch of a feature's boundary and the unit normal out of it. */
interface Face extends Segment {
  normal: Point;
}

/** A feature as the glide sees it: where it lies nearest a point, and the faces of its boundary, both in the coordinates the feature is given in. */
interface Feature {
  nearest: (point: Point) => Point;
  faces: () => Face[];
}

function rectFeature(rect: Rect): Feature {
  return {
    nearest: (to) => closestOnRect(to, rect),
    faces: () => {
      const [nw, ne, se, sw] = corners(rect) as [Point, Point, Point, Point];
      return [
        { a: nw, b: ne, normal: { x: 0, z: -1 } },
        { a: ne, b: se, normal: { x: 1, z: 0 } },
        { a: se, b: sw, normal: { x: 0, z: 1 } },
        { a: sw, b: nw, normal: { x: -1, z: 0 } },
      ];
    },
  };
}

/** A segment has a face on each side. */
function segmentFeature(segment: Segment): Feature {
  return {
    nearest: (to) => closestOnSegment(to, segment),
    faces: () => {
      const length = distance(segment.a, segment.b);
      if (length === 0) return [];
      const normal = { x: (segment.a.z - segment.b.z) / length, z: (segment.b.x - segment.a.x) / length };
      return [
        { ...segment, normal },
        { ...segment, normal: { x: -normal.x, z: -normal.z } },
      ];
    },
  };
}

/** A model-space feature taken in the space the model stands in. */
function inModel(transform: Transform, feature: Feature): Feature {
  const turn = { x: 0, z: 0, yaw: transform.yaw };
  return {
    nearest: (to) => modelToWorld(transform, feature.nearest(worldToModel(transform, to))),
    faces: () =>
      feature.faces().map((face) => ({ a: modelToWorld(transform, face.a), b: modelToWorld(transform, face.b), normal: modelToWorld(turn, face.normal) })),
  };
}

/**
 * Whether `visit` accepts one of the edges, blockers, colliders, and ledges that a circle of
 * `radius` centred on the point touches. The walk stops at the first it accepts.
 */
function someFeatureTouched(collision: SpaceCollision, point: Point, radius: number, visit: (feature: Feature) => boolean): boolean {
  const reach = radius - CONTACT_TOLERANCE;
  for (const edge of collision.edges) {
    if (distanceToSegment(point, edge) < reach && visit(segmentFeature(edge))) return true;
  }
  for (const rect of collision.blockers) {
    if (distanceToRect(point, rect) < reach && visit(rectFeature(rect))) return true;
  }
  for (const model of collision.models) {
    if (distance(point, model.transform) > model.reach + radius) continue;
    const local = worldToModel(model.transform, point);
    for (const rect of model.colliders) {
      if (distanceToRect(local, rect) < reach && visit(inModel(model.transform, rectFeature(rect)))) return true;
    }
    for (const ledge of model.ledges) {
      if (distanceToSegment(local, ledge) < reach && visit(inModel(model.transform, segmentFeature(ledge)))) return true;
    }
  }
  return false;
}

/** True when a circle of `radius` centred on the point lies inside the space and touches no blocker, collider, or ledge. */
export function isClear(collision: SpaceCollision, point: Point, radius: number): boolean {
  return collision.sectors.some((rect) => rectContains(rect, point, EDGE_TOLERANCE)) && !someFeatureTouched(collision, point, radius, () => true);
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
  /** The move was cut short or turned aside. */
  blocked: boolean;
}

/**
 * The client's step from `from` toward `to`, in substeps of at most `MOVE_SUBSTEP`: the full
 * substep where it is legal, else a glide along what refused it, else a slide along one axis,
 * else a stop. `bodies` are the other players and monsters at the positions the client draws them.
 *
 * The glide removes from the substep the part that pushes into each face refusing it, so a body
 * follows a face at any yaw and rounds a corner or a round body. It never leans into any of
 * those faces, so in a corner there is no glide unless the step runs along one face away from the
 * other. A face first counts as the run it makes with the faces in line with it, which keeps a body
 * flush along a wall of pieces. Where that glide is refused, each feature counts as it lies.
 */
export function resolveMove(collision: SpaceCollision, from: Point, to: Point, radius: number, npcs: readonly Body[], bodies: readonly Body[]): ResolvedMove {
  const substeps = Math.max(1, Math.ceil(distance(from, to) / MOVE_SUBSTEP));
  const step = { x: (to.x - from.x) / substeps, z: (to.z - from.z) / substeps };
  let position = from;
  let blocked = false;
  const legal = (next: Point): boolean =>
    isLegalMove(collision, position, next, radius, npcs) && !bodies.some((body) => bodyBlocks(position, next, radius, body));
  for (let index = 0; index < substeps; index += 1) {
    const full = { x: position.x + step.x, z: position.z + step.z };
    if (legal(full)) {
      position = full;
      continue;
    }
    blocked = true;
    const { runs, own } = contactNormals(collision, position, full, radius, npcs, bodies);
    const glided = (normals: readonly Point[]): Point | undefined => {
      const glide = glideAlong(step, normals);
      return glide === undefined ? undefined : { x: position.x + glide.x, z: position.z + glide.z };
    };
    const alongX = step.x === 0 ? undefined : { x: position.x + step.x, z: position.z };
    const alongZ = step.z === 0 ? undefined : { x: position.x, z: position.z + step.z };
    const next = [glided(runs), glided(own), alongX, alongZ].find((candidate) => candidate !== undefined && legal(candidate));
    if (next === undefined) break;
    position = next;
  }
  return { position, blocked };
}

/**
 * The step less its push into each normal, or `undefined` where what is left still leans into
 * one of them (a wedge), turns back against the step, or is too short to count.
 */
function glideAlong(step: Point, normals: readonly Point[]): Point | undefined {
  let glide = step;
  for (const normal of normals) {
    const push = Math.min(dot(glide, normal), 0);
    glide = { x: glide.x - push * normal.x, z: glide.z - push * normal.z };
  }
  if (normals.some((normal) => dot(glide, normal) < -WEDGE_TOLERANCE)) return undefined;
  if (dot(glide, step) <= 0 || Math.hypot(glide.x, glide.z) < NEGLIGIBLE_GLIDE) return undefined;
  return glide;
}

/**
 * For every feature that refuses a step from `at` to `probe`, the unit vector out to `at` from
 * where the feature lies nearest it: `own` as each feature lies, and `runs` with a joint taken as
 * the run it lies in. The static world refuses as `isClear` judges it, an NPC the probe overlaps,
 * and another body only where it stops the step, so an overlapping pair can still separate.
 */
function contactNormals(
  collision: SpaceCollision,
  at: Point,
  probe: Point,
  radius: number,
  npcs: readonly Body[],
  bodies: readonly Body[],
): { runs: Point[]; own: Point[] } {
  // Only the stretch of a run between a refusing feature's nearest point and `at`'s foot on its line
  // decides the normal, and every face there lies this near `at`, whether or not it refuses the step itself.
  const nearby: Face[] = [];
  someFeatureTouched(collision, at, radius + distance(at, probe) + EDGE_TOLERANCE, (feature) => {
    nearby.push(...feature.faces());
    return false;
  });
  const roundoff = FACE_ROUNDOFF * Math.max(1, Math.abs(at.x), Math.abs(at.z));
  const runs: Point[] = [];
  const own: Point[] = [];
  someFeatureTouched(collision, probe, radius, (feature) => {
    const point = feature.nearest(at);
    const normal = outFrom(point, at);
    const run = runNormal(point, at, feature.faces(), nearby, roundoff);
    own.push(...normal);
    runs.push(...(run === undefined ? normal : [run]));
    return false;
  });
  const centres = [...npcs.filter((npc) => touches(probe, radius, [npc])), ...bodies.filter((body) => bodyBlocks(at, probe, radius, body))];
  const fromCentres = centres.flatMap((centre) => outFrom(centre, at));
  return { runs: [...runs, ...fromCentres], own: [...own, ...fromCentres] };
}

/**
 * The normal at `at` of the run through the point where a feature lies nearest `at`, such as two
 * wall pieces or two sectors' edges in a line. Beside the run it is the run's own normal, and past
 * it the vector out from the run's end, so a joint inside a run is no corner and the run's end still
 * is. Where several of the feature's faces run through the point, as at a corner, the run nearest
 * `at` counts. `undefined` where none runs through it with `at` in front.
 */
function runNormal(point: Point, at: Point, faces: readonly Face[], nearby: readonly Face[], roundoff: number): Point | undefined {
  let best: { normal: Point; length: number } | undefined;
  for (const face of faces) {
    if (distance(point, closestOnSegment(point, face)) > roundoff || offset(at, face, face.normal) < -roundoff) continue;
    const tangent = tangentOf(face);
    const [low, high] = runOf(face, nearby, roundoff);
    const beside = offset(at, face, tangent);
    const end = clamp(beside, low, high);
    const source = { x: face.a.x + tangent.x * end, z: face.a.z + tangent.z * end };
    const length = end === beside ? offset(at, face, face.normal) : distance(source, at);
    if (length <= 0 || (best !== undefined && length >= best.length)) continue;
    best = { normal: end === beside ? face.normal : outFrom(source, at)[0]!, length };
  }
  return best?.normal;
}

/**
 * Where the run the face lies in starts and ends along the face's line, measured from the face's
 * start. The run is the face and the nearby faces on its line, out the same way, that chain to it
 * with gaps of at most `EDGE_TOLERANCE`.
 */
function runOf(face: Face, nearby: readonly Face[], roundoff: number): [number, number] {
  const tangent = tangentOf(face);
  const stretch = (other: Face): [number, number] => {
    const a = offset(other.a, face, tangent);
    const b = offset(other.b, face, tangent);
    return [Math.min(a, b), Math.max(a, b)];
  };
  const own = stretch(face);
  const stretches = [own, ...nearby.filter((other) => inLine(face, other, roundoff)).map(stretch)].sort((one, other) => one[0] - other[0]);
  let [low, high] = stretches[0]!;
  for (const [from, to] of stretches) {
    if (from > high + EDGE_TOLERANCE) {
      if (high >= own[0]) break;
      low = from;
    }
    high = Math.max(high, to);
  }
  return [low, high];
}

/** Whether the other face lies on the face's line, out the same way. */
function inLine(face: Face, other: Face, roundoff: number): boolean {
  return dot(face.normal, other.normal) > 0 && [other.a, other.b].every((end) => Math.abs(offset(end, face, face.normal)) <= roundoff);
}

/** How far the point lies from the face's start in the direction. */
function offset(point: Point, face: Face, direction: Point): number {
  return dot({ x: point.x - face.a.x, z: point.z - face.a.z }, direction);
}

function tangentOf(face: Face): Point {
  return { x: face.normal.z, z: -face.normal.x };
}

/** The unit vector out to `at` from the source, none where the two coincide. */
function outFrom(source: Point, at: Point): Point[] {
  const length = distance(source, at);
  return length === 0 ? [] : [{ x: (at.x - source.x) / length, z: (at.z - source.z) / length }];
}

function dot(a: Point, b: Point): number {
  return a.x * b.x + a.z * b.z;
}
