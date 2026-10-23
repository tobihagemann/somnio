import { markPointBounds } from '@somnio/protocol';
import type { GroundMark, Placement } from '@somnio/protocol';
import { buildSpaceCollision, isClear, npcBodies } from '../../src/collision.ts';
import type { Body, SpaceCollision } from '../../src/collision.ts';
import { SOMNIO_CONSTANTS } from '../../src/constants.ts';
import { clamp, closestOnSegment, distance, rectContains } from '../../src/geometry.ts';
import type { Point } from '../../src/geometry.ts';
import { seededSequence } from '../../src/hash.ts';
import { objectModel } from '../../src/modelRegistry.ts';
import type { ModelRegistry } from '../../src/modelRegistry.ts';
import { sectorPointInSpace, sectorRect, spawnArea } from '../../src/sector.ts';
import type { Sector } from '../../src/sector.ts';
import { OUTDOOR_SPACE_ID, resolveDoor } from '../../src/world.ts';
import { CORRIDOR, DOOR_PATH, LINKS, OPENINGS, PLAZA, ROADS, SPLASH_KEEP_OUTS, STREETS } from './rules.ts';
import type { Circle, KeepOut, LandRules, Road } from './rules.ts';

/**
 * Composes the outdoor lands from rules: roads and worn ground as ground marks, and clusters of
 * trees with bushes at their rims and loose bushes and rocks as placements. Everything it writes
 * carries an id starting `gen-`, and everything else in a sector is left exactly as it is, so a
 * land can be composed again with other seeds or rules and keep what was authored by hand.
 *
 * Every outdoor sector is composed in one run, in name order: each is stripped of its `gen-`
 * records first, then dressed against the collision of the whole outdoor space as composed so far,
 * so nothing placed near a border stands in what was placed across it. The same input composes the
 * same bytes, its own output included.
 */

const GENERATED = 'gen-';
/** How far past a keep-out's edge the dressing thins, from none at the edge to full at the band's far side. */
const THIN_BAND = 3;
/** How far a placement keeps from a door's doorway and arrival point, the spawn, and an NPC. */
const DOORWAY_CLEARANCE = 2;
/** The dressed window the density targets count per. */
const WINDOW_AREA = 64;
/** How far a generated tree keeps from every other generated placement, and a bush or rock from another bush or rock. */
const TREE_SPACING = 1.3;
const PROP_SPACING = 0.9;
/** The spacing of the samples a road is cut into per sector. */
const ROAD_SAMPLE = 1;
/** The grid a path is routed on, how far from its start it may look for a goal, and how far it keeps from what blocks. */
const PATH_CELL = 0.32;
const PATH_SEARCH = 30;
const PATH_CLEARANCE = SOMNIO_CONSTANTS.playerRadius + 0.3;
/** Within this distance of a route's start it needs only a body's clearance from what blocks, since a door or link route starts at an arrival point just before a building. */
const PATH_DOORWAY = 1.5;
/** The clearance past which a path no longer cares how far it is from what blocks, and how much dearer a step at none is. */
const PATH_OPEN = 2;
const PATH_CENTRING = 4;

/** The way on foot from a point to the edge of the nearest of `goals`, across the outdoor space being composed. */
type Route = (start: Point, goals: readonly Road[]) => Point[] | undefined;

export function composeSectors(sectors: readonly Sector[], lands: readonly LandRules[], registry: ModelRegistry): Sector[] {
  const composed = sectors.map((sector) => (sector.kind === 'outdoor' ? strip(sector) : structuredClone(sector)));
  const outdoor = composed.filter((sector) => sector.kind === 'outdoor').toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const placed: Circle[] = [];
  const space = { id: OUTDOOR_SPACE_ID, sectors: outdoor };
  const collision = buildSpaceCollision(space, registry);
  const npcs = npcBodies(space);
  const route: Route = (start, goals) => routeToRoad(collision, npcs, start, goals);
  const doors = doorPaths(outdoor, registry, route);
  const roads = [...doors, ...openingPaths(route, doors), ...linkPaths(route, doors), ...ROADS];
  const painted = new Map(outdoor.map((sector) => [sector, roadMarks(sector, roads)]));
  const keepOuts: KeepOut[] = [
    ...SPLASH_KEEP_OUTS,
    ...roads.map((road) => ({ points: road.points, radius: road.radius + CORRIDOR })),
    // A painted stroke is clamped into the bounds the codec accepts, so it can lie off its road's line.
    ...[...painted].flatMap(([sector, marks]) =>
      marks.flatMap((mark) =>
        mark.shape.kind === 'stroke'
          ? [{ points: mark.shape.points.map((point) => sectorPointInSpace(sector, point)), radius: mark.shape.radius + CORRIDOR }]
          : [],
      ),
    ),
  ];
  for (const [sector, marks] of painted) {
    const rules = lands.find((land) => land.sector === sector.name);
    sector.ground.marks = [...marks, ...plazaMarks(sector), ...(rules === undefined ? [] : wornMarks(sector, rules)), ...sector.ground.marks];
    if (rules !== undefined) dress(sector, rules, outdoor, keepOuts, placed, registry);
  }
  return composed;
}

function strip(sector: Sector): Sector {
  const copy = structuredClone(sector);
  copy.placements = copy.placements.filter((placement) => !placement.id.startsWith(GENERATED));
  copy.ground.marks = copy.ground.marks.filter((mark) => !mark.id.startsWith(GENERATED));
  return copy;
}

/**
 * A dirt path from each outdoor door's arrival point to the edge of the nearest of the town's
 * streets, routed round whatever blocks the way, an NPC included, since a path through a wall would
 * read as a way through it. The paths come before the roads, so a street paints over where one meets it.
 */
function doorPaths(sectors: readonly Sector[], registry: ModelRegistry, route: Route): Road[] {
  return sectors.flatMap((sector) =>
    sector.doors.flatMap((door) => {
      const resolved = resolveDoor(sector, door, registry);
      const points = resolved === undefined ? undefined : route(resolved.arrival, STREETS);
      return resolved === undefined || points === undefined ? [] : [{ id: doorPathId(door.id), ...DOOR_PATH, points: [resolved.doorway, ...points] }];
    }),
  );
}

function doorPathId(doorId: string): string {
  return `${GENERATED}path-${doorId}`;
}

/**
 * A dirt path through each compound opening no door path runs through, from just inside its yard
 * to the edge of the nearest street, and for an opening that joins, on into the yard to the edge
 * of the nearest door path. It comes after the door paths, so it paints over the one it joins.
 */
function openingPaths(route: Route, doors: readonly Road[]): Road[] {
  return OPENINGS.flatMap((opening) => {
    const outward = route(opening.inside, STREETS);
    if (outward === undefined) return [];
    if (!opening.join) return [{ id: opening.id, ...DOOR_PATH, points: outward }];
    const inward = route(opening.inside, doors);
    return inward === undefined ? [] : [{ id: opening.id, ...DOOR_PATH, points: [...inward.toReversed(), ...outward.slice(1)] }];
  });
}

/** A dirt path joining two doors of a compound whose paths do not meet, from the arrival point of one to the edge of the other's path. */
function linkPaths(route: Route, doors: readonly Road[]): Road[] {
  return LINKS.flatMap((link) => {
    // A door path's second point is its arrival point, after the doorway.
    const start = doors.find((road) => road.id === doorPathId(link.from))?.points[1];
    if (start === undefined) return [];
    const points = route(
      start,
      doors.filter((road) => road.id === doorPathId(link.to)),
    );
    return points === undefined ? [] : [{ id: link.id, ...DOOR_PATH, points }];
  });
}

/**
 * The way on foot from `start` to the edge of the nearest of `goals`, found on a grid where a step
 * costs more the nearer it passes what blocks, so a path keeps to the middle of a gap in a wall. It
 * is then pulled straight wherever a straight line keeps as clear as the stretch of the route it
 * replaces. `undefined` when no goal is within reach or `start` already stands on one.
 */
function routeToRoad(collision: SpaceCollision, npcs: readonly Body[], start: Point, goals: readonly Road[]): Point[] | undefined {
  const onRoad = (point: Point): { centre: Point; radius: number } | undefined => {
    for (const road of goals) {
      const centre = nearestOnLine(road.points, point);
      if (distance(centre, point) <= road.radius) return { centre, radius: road.radius };
    }
    return undefined;
  };
  if (onRoad(start) !== undefined) return undefined;
  const nearDoorway = (point: Point): boolean => distance(point, start) < PATH_DOORWAY;
  const clearances = new Map<string, number>();
  /** How far `point` stands from what blocks, at most `PATH_OPEN`: to a tenth of a metre from the collision, exactly from an NPC. */
  const clearance = (point: Point): number => {
    const key = `${round(point.x)},${round(point.z)}`;
    let known = clearances.get(key);
    if (known === undefined) {
      let low = 0;
      let high = PATH_OPEN * 10;
      if (!isClear(collision, point, 0)) high = -1;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (isClear(collision, point, mid / 10)) low = mid;
        else high = mid - 1;
      }
      known = Math.min(high < 0 ? -1 : low / 10, ...npcs.map((npc) => distance(point, npc) - npc.radius));
      clearances.set(key, known);
    }
    return known;
  };
  const walkable = (point: Point): boolean => clearance(point) >= (nearDoorway(point) ? SOMNIO_CONSTANTS.playerRadius : PATH_CLEARANCE);
  const side = Math.ceil((2 * PATH_SEARCH) / PATH_CELL);
  const cellPoint = (cell: number): Point => ({
    x: start.x - PATH_SEARCH + ((cell % side) + 0.5) * PATH_CELL,
    z: start.z - PATH_SEARCH + (Math.floor(cell / side) + 0.5) * PATH_CELL,
  });
  const open = (cell: number): boolean => walkable(cellPoint(cell));
  const first = Math.floor(side / 2) * side + Math.floor(side / 2);
  const cost = new Map([[first, 0]]);
  const from = new Map<number, number>();
  const queue = new MinQueue();
  queue.push(first, 0);
  let goal: number | undefined;
  while (goal === undefined) {
    const cell = queue.pop();
    if (cell === undefined) return undefined;
    if (cell !== first && onRoad(cellPoint(cell)) !== undefined) goal = cell;
    const i = cell % side;
    const j = Math.floor(cell / side);
    for (const [di, dj] of NEIGHBOURS) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= side || nj >= side) continue;
      const next = nj * side + ni;
      if (!open(next) || (di !== 0 && dj !== 0 && (!open(j * side + ni) || !open(nj * side + i)))) continue;
      const crowding = (PATH_OPEN - clearance(cellPoint(next))) / PATH_OPEN;
      const reached = cost.get(cell)! + Math.hypot(di, dj) * PATH_CELL * (1 + PATH_CENTRING * crowding);
      if (reached >= (cost.get(next) ?? Infinity)) continue;
      cost.set(next, reached);
      from.set(next, cell);
      queue.push(next, reached);
    }
  }
  const cells = [goal];
  while (cells[0] !== first) cells.unshift(from.get(cells[0]!)!);
  const road = onRoad(cellPoint(goal))!;
  const last = cellPoint(goal);
  const across = distance(road.centre, last);
  const edge =
    across === 0
      ? last
      : {
          x: road.centre.x + ((last.x - road.centre.x) * road.radius) / across,
          z: road.centre.z + ((last.z - road.centre.z) * road.radius) / across,
        };
  const route = [start, ...cells.slice(1, -1).map(cellPoint), edge];
  // A straight line may stand in for the route between two of its points where it keeps at least
  // the least clearance the route keeps between them away from the doorway, less half a grid step.
  const keepsClear = (at: number, reach: number): boolean => {
    const floor = Math.min(PATH_OPEN, ...route.slice(at + 1, reach).flatMap((point) => (nearDoorway(point) ? [] : [clearance(point)]))) - PATH_CELL / 2;
    const a = route[at]!;
    const b = route[reach]!;
    const steps = Math.max(1, Math.ceil(distance(a, b) / (PATH_CELL / 2)));
    for (let step = 1; step < steps; step += 1) {
      const point = { x: a.x + ((b.x - a.x) * step) / steps, z: a.z + ((b.z - a.z) * step) / steps };
      if (!walkable(point) || (!nearDoorway(point) && clearance(point) < floor)) return false;
    }
    return true;
  };
  const pulled = [start];
  for (let at = 0; at < route.length - 1;) {
    let reach = route.length - 1;
    while (reach > at + 1 && !keepsClear(at, reach)) reach -= 1;
    pulled.push(route[reach]!);
    at = reach;
  }
  return pulled.map((point) => ({ x: round(point.x), z: round(point.z) }));
}

const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

/** A binary heap of grid cells by cost, cheapest first. */
class MinQueue {
  private readonly items: { cell: number; cost: number }[] = [];

  push(cell: number, cost: number): void {
    const items = this.items;
    items.push({ cell, cost });
    for (let at = items.length - 1; at > 0;) {
      const parent = (at - 1) >> 1;
      if (items[parent]!.cost <= items[at]!.cost) break;
      [items[parent], items[at]] = [items[at]!, items[parent]!];
      at = parent;
    }
  }

  pop(): number | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (top === undefined || last === undefined || items.length === 0) return top?.cell;
    items[0] = last;
    for (let at = 0; ;) {
      const left = at * 2 + 1;
      const right = left + 1;
      let least = at;
      if (left < items.length && items[left]!.cost < items[least]!.cost) least = left;
      if (right < items.length && items[right]!.cost < items[least]!.cost) least = right;
      if (least === at) break;
      [items[least], items[at]] = [items[at]!, items[least]!];
      at = least;
    }
    return top.cell;
  }
}

/** Each road's runs across the sector, one stroke per run, each point held where the codec accepts it. */
function roadMarks(sector: Sector, roads: readonly Road[]): GroundMark[] {
  const rect = sectorRect(sector);
  const marks: GroundMark[] = [];
  for (const road of roads) {
    const bounds = markPointBounds(sector.size, { kind: 'stroke', radius: road.radius });
    if (bounds === undefined) continue;
    const runs: Point[][] = [];
    let run: Point[] = [];
    for (const sample of sampled(road.points)) {
      if (rectContains(rect, sample, road.radius)) {
        const local = {
          x: clamp(round(sample.x - rect.x), round(bounds.x + 0.0005), round(bounds.x + bounds.width - 0.0005)),
          z: clamp(round(sample.z - rect.z), round(bounds.z + 0.0005), round(bounds.z + bounds.depth - 0.0005)),
        };
        if (run.length === 0 || distance(run.at(-1)!, local) > 0.001) run.push(local);
      } else if (run.length > 0) {
        runs.push(run);
        run = [];
      }
    }
    if (run.length > 0) runs.push(run);
    runs.forEach((points, index) => {
      marks.push({
        id: runs.length === 1 ? road.id : `${road.id}-${index + 1}`,
        materialId: road.materialId,
        opacity: road.opacity,
        shape: { kind: 'stroke', radius: road.radius, points },
      });
    });
  }
  return marks;
}

function plazaMarks(sector: Sector): GroundMark[] {
  const rect = sectorRect(sector);
  if (!rectContains(rect, PLAZA.centre)) return [];
  const points = Array.from({ length: 10 }, (_, index) => {
    const angle = (index / 10) * Math.PI * 2;
    return { x: round(PLAZA.centre.x - rect.x + Math.cos(angle) * PLAZA.radius), z: round(PLAZA.centre.z - rect.z + Math.sin(angle) * PLAZA.radius) };
  });
  return [{ id: PLAZA.id, materialId: PLAZA.materialId, opacity: 1, shape: { kind: 'polygon', points } }];
}

function wornMarks(sector: Sector, rules: LandRules): GroundMark[] {
  const rect = sectorRect(sector);
  return rules.worn.map((worn, index) => ({
    id: `${GENERATED}worn-${index + 1}`,
    materialId: 'dirt-path',
    opacity: 0.5,
    shape: { kind: 'stroke', radius: worn.radius, points: [{ x: round(worn.x - rect.x), z: round(worn.z - rect.z) }] },
  }));
}

/**
 * Clusters of trees with bushes at their rims, then loose bushes and rocks, each drawn at a random
 * spot and yaw and kept only where nothing blocks its trunk and its crown keeps clear of every road
 * as painted, clearing, doorway, splash path, and monster spawn area. Within `THIN_BAND` of a
 * keep-out, a draw is kept with a chance that grows with how far its crown stands from it.
 */
function dress(sector: Sector, rules: LandRules, outdoor: readonly Sector[], keepOuts: readonly KeepOut[], placed: Circle[], registry: ModelRegistry): void {
  const random = seededSequence(rules.seed);
  const rect = sectorRect(sector);
  const collision = buildSpaceCollision({ id: OUTDOOR_SPACE_ID, sectors: [...outdoor] }, registry);
  const doorways = outdoor.flatMap((each) => [
    ...each.doors.flatMap((door) => {
      const resolved = resolveDoor(each, door, registry);
      return resolved === undefined ? [] : [resolved.arrival, resolved.doorway];
    }),
    ...(each.spawn === undefined ? [] : [sectorPointInSpace(each, each.spawn)]),
    ...each.npcs.map((npc) => sectorPointInSpace(each, npc)),
  ]);
  const spawnAreas = outdoor.flatMap((each) => each.monsterSpawns.map((spawn) => spawnArea(each, spawn)));
  const open = (point: Point, reach: number): boolean =>
    rectContains(rect, point) &&
    !rules.clearings.some((clearing) => distance(point, clearing) < clearing.radius + reach) &&
    !keepOuts.some((keepOut) => distance(point, nearestOnLine(keepOut.points, point)) < keepOut.radius + reach) &&
    !doorways.some((doorway) => distance(point, doorway) < DOORWAY_CLEARANCE + reach) &&
    !spawnAreas.some((area) => rectContains(area, point, reach));

  const counter = new Map<string, number>();
  const tryPlace = (models: readonly string[], point: Point, spacing: number): boolean => {
    const modelId = models[Math.floor(random() * models.length)]!;
    const yaw = Math.round(random() * 360) % 360;
    const rule = objectModel(registry, modelId);
    if (rule === undefined) return false;
    const reach = Math.max(
      ...rule.colliders.map((collider) =>
        Math.hypot(
          Math.max(Math.abs(collider.x), Math.abs(collider.x + collider.width)),
          Math.max(Math.abs(collider.z), Math.abs(collider.z + collider.depth)),
        ),
      ),
      0.1,
    );
    const crown = Math.max(reach, Math.hypot(rule.footprint.width, rule.footprint.depth) / 2);
    const margin = Math.min(...keepOuts.map((keepOut) => distance(point, nearestOnLine(keepOut.points, point)) - keepOut.radius)) - crown;
    if (margin >= 0 && margin < THIN_BAND && random() * THIN_BAND > margin) return false;
    if (!open(point, crown) || !isClear(collision, point, reach + 0.05) || placed.some((other) => distance(point, other) < Math.max(spacing, other.radius)))
      return false;
    const count = (counter.get(modelId) ?? 0) + 1;
    counter.set(modelId, count);
    const placement: Placement = { id: `${GENERATED}${modelId}-${count}`, modelId, x: round(point.x - rect.x), z: round(point.z - rect.z), yaw, elevation: 0 };
    sector.placements.push(placement);
    placed.push({ ...point, radius: spacing });
    return true;
  };

  const windows = (rect.width * rect.depth * openShare(rect, open, random)) / WINDOW_AREA;
  const clusters = Math.round(windows * rules.clustersPerWindow);
  for (let cluster = 0; cluster < clusters; cluster += 1) {
    let centre: Point | undefined;
    for (let attempt = 0; attempt < 40 && centre === undefined; attempt += 1) {
      const candidate = { x: rect.x + random() * rect.width, z: rect.z + random() * rect.depth };
      if (open(candidate, 0.5)) centre = candidate;
    }
    if (centre === undefined) continue;
    const trees = rules.clusterTrees[0] + Math.floor(random() * (rules.clusterTrees[1] - rules.clusterTrees[0] + 1));
    let made = 0;
    for (let attempt = 0; attempt < 30 && made < trees; attempt += 1) {
      const angle = random() * Math.PI * 2;
      const reach = Math.sqrt(random()) * rules.clusterRadius;
      if (tryPlace(rules.trees, { x: centre.x + Math.cos(angle) * reach, z: centre.z + Math.sin(angle) * reach }, TREE_SPACING)) made += 1;
    }
    for (let bush = 0; bush < made; bush += 1) {
      const angle = random() * Math.PI * 2;
      const reach = rules.clusterRadius * (0.8 + random() * 0.6);
      tryPlace(rules.bushes, { x: centre.x + Math.cos(angle) * reach, z: centre.z + Math.sin(angle) * reach }, PROP_SPACING);
    }
  }
  const props = Math.round(windows * rules.propsPerWindow);
  for (let prop = 0; prop < props; prop += 1) {
    const point = { x: rect.x + random() * rect.width, z: rect.z + random() * rect.depth };
    tryPlace(random() < 0.5 ? rules.bushes : rules.rocks, point, PROP_SPACING);
  }
}

/** The share of the sector open to dressing, from a fixed sample. */
function openShare(rect: { x: number; z: number; width: number; depth: number }, open: (point: Point, reach: number) => boolean, random: () => number): number {
  let inside = 0;
  for (let sample = 0; sample < 400; sample += 1) if (open({ x: rect.x + random() * rect.width, z: rect.z + random() * rect.depth }, 0)) inside += 1;
  return inside / 400;
}

function sampled(points: readonly Point[]): Point[] {
  const samples: Point[] = [points[0]!];
  points.slice(1).forEach((to, index) => {
    const from = points[index]!;
    const steps = Math.max(1, Math.ceil(distance(from, to) / ROAD_SAMPLE));
    for (let step = 1; step <= steps; step += 1) samples.push({ x: from.x + ((to.x - from.x) * step) / steps, z: from.z + ((to.z - from.z) * step) / steps });
  });
  return samples;
}

function nearestOnLine(points: readonly Point[], point: Point): Point {
  if (points.length === 1) return points[0]!;
  let best = points[0]!;
  points.slice(1).forEach((to, index) => {
    const candidate = closestOnSegment(point, { a: points[index]!, b: to });
    if (distance(candidate, point) < distance(best, point)) best = candidate;
  });
  return best;
}

/** To the millimetre, so written files hold short decimals. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
