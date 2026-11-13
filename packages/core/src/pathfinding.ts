import type { SectorView } from '@somnio/protocol';
import { MOVE_SUBSTEP, bodiesBlockLine, collisionNear, isClear } from './collision.ts';
import type { Body, SpaceCollision } from './collision.ts';
import { SOMNIO_CONSTANTS } from './constants.ts';
import { distance } from './geometry.ts';
import type { Point, Rect } from './geometry.ts';
import { sectorRect } from './sector.ts';

/**
 * Paths a walker can follow, found on one grid of square cells anchored at the space's origin, so
 * the cells of neighbouring sectors line up and a path crosses a border on shared neighbours.
 *
 * Every part judges a step by one rule, `legWalkable`'s: the search over the grid's edges, the
 * string-pulling of its cells into legs, the goal's end point, and the retry without an edge a leg
 * found unwalkable. A part that judged by a looser rule would hand another a step it refuses. A
 * search applies it over the collision cut into tiles, which answer every point as the whole
 * collision would.
 */

export const PATHFINDING = {
  /** The side of a cell. */
  cell: 0.25,
  /** How far beyond the start and the goal a search looks. */
  windowMargin: 10,
  /** The most cells one search expands. */
  maxExpansions: 30_000,
  /** How far from the start a body is planned round. */
  bodyRange: 16,
  /** Room kept between the walker and a body it plans round, and where a goal within that room is moved out to. */
  bodyMargin: 0.05,
  /** How many times one search runs again without an edge its legs could not take. */
  maxRetries: 3,
} as const;

const RADIUS = SOMNIO_CONSTANTS.playerRadius;
const BODY_RADIUS = RADIUS + PATHFINDING.bodyMargin;
const DIAGONAL = PATHFINDING.cell * Math.SQRT2;
/** A cell clear at this radius has every edge clear, since no sample of an edge lies further than a diagonal from its centre. */
const ROOMY_RADIUS = RADIUS + DIAGONAL + 1e-6;
/** The side of the tiles `isClear` is answered over, each holding only the features near it. */
const TILE = 2;
const TILE_REACH = ROOMY_RADIUS + 0.01;
/** What a sector's raster reads beyond its rect: the ring of cells round it. */
const RASTER_REACH = PATHFINDING.cell + TILE_REACH;

const CLEAR = 1;
/** The edges a cell holds, each to a cell after it; the cell an edge leaves in one of these directions holds it. */
const FORWARD_EDGES = [
  { column: 1, row: 0, bit: 2 },
  { column: 1, row: 1, bit: 4 },
  { column: 0, row: 1, bit: 8 },
  { column: -1, row: 1, bit: 16 },
] as const;
/** The eight steps to a neighbour, each with the bit of its edge and whether the cell it leaves holds that bit or the cell it enters does. */
const STEPS = FORWARD_EDGES.flatMap(({ column, row, bit }) => {
  const cost = column !== 0 && row !== 0 ? DIAGONAL : PATHFINDING.cell;
  return [
    { column, row, bit, cost, heldHere: true },
    { column: -column, row: -row, bit, cost, heldHere: false },
  ];
});

/**
 * Where a body can be in one sector, from the static world alone: for each cell whose centre lies in
 * the sector's rect, whether a body is clear at its centre, and which of its forward edges
 * (`FORWARD_EDGES`) `legWalkable` lets a body take without bodies in the way.
 */
export interface WalkRaster {
  sector: string;
  /** The grid column and row of the first cell, counted from the space's origin. */
  column: number;
  row: number;
  columns: number;
  rows: number;
  /** Row by row, each cell's bits. */
  cells: Uint8Array;
}

/** What one sector's raster is computed from. */
export interface WalkRasterInputs {
  sector: string;
  rect: Rect;
  /** The part of the space's collision the sector's cells can touch. */
  collision: SpaceCollision;
}

export function walkRasterInputs(collision: SpaceCollision, sector: SectorView): WalkRasterInputs {
  const rect = sectorRect(sector);
  return { sector: sector.name, rect, collision: collisionNear(collision, rect, RASTER_REACH) };
}

export function rasterizeWalkable({ sector, rect, collision }: WalkRasterInputs): WalkRaster {
  const column = firstCell(rect.x);
  const row = firstCell(rect.z);
  const columns = firstCell(rect.x + rect.width) - column;
  const rows = firstCell(rect.z + rect.depth) - row;
  const clear = tiledClearance(collision);
  // Which cell centres are clear: the sector's, and those beyond it where its border cells' forward
  // edges end, a column on either side and the row past its far edge. No forward edge leads back a row.
  const clearColumns = columns + 2;
  const clearCentres = new Uint8Array(clearColumns * (rows + 1));
  for (let clearRow = 0; clearRow < rows + 1; clearRow += 1) {
    for (let clearColumn = 0; clearColumn < clearColumns; clearColumn += 1) {
      if (clear(cellCentre(column - 1 + clearColumn, row + clearRow), RADIUS)) clearCentres[clearRow * clearColumns + clearColumn] = 1;
    }
  }
  const cells = new Uint8Array(columns * rows);
  for (let cellRow = 0; cellRow < rows; cellRow += 1) {
    for (let cellColumn = 0; cellColumn < columns; cellColumn += 1) {
      if (clearCentres[cellRow * clearColumns + cellColumn + 1] === 0) continue;
      const centre = cellCentre(column + cellColumn, row + cellRow);
      const roomy = clear(centre, ROOMY_RADIUS);
      let bits = CLEAR;
      for (const edge of FORWARD_EDGES) {
        if (clearCentres[(cellRow + edge.row) * clearColumns + cellColumn + 1 + edge.column] === 0) continue;
        const end = cellCentre(column + cellColumn + edge.column, row + cellRow + edge.row);
        if (roomy || everySample(centre, end, (sample) => clear(sample, RADIUS))) bits |= edge.bit;
      }
      cells[cellRow * columns + cellColumn] = bits;
    }
  }
  return { sector, column, row, columns, rows, cells };
}

/**
 * The one rule every part of the pathfinder judges a step by. A leg is walkable when every sample
 * along it, at most `MOVE_SUBSTEP` apart, is clear at the full `playerRadius`, and the bodies do not
 * stop it by `bodiesBlockLine`. Where the leg starts clear of every body by `bodyMargin`, it judges
 * the bodies at `playerRadius` plus that margin, and otherwise at `playerRadius` alone. Either way
 * it is the follower's rule at any spacing of its steps, or stricter only by a margin the leg
 * starts clear of, so a leg can always lead out of the bodies the walker touches. The rule uses the
 * full radius, not `isLegalMove`'s path tolerance, because `resolveMove` tests each substep at the
 * full radius, and a leg grazing a corner within the tolerance would stop the walker dead.
 */
export function legWalkable(collision: SpaceCollision, from: Point, to: Point, bodies: readonly Body[]): boolean {
  return walkable((point) => isClear(collision, point, RADIUS), from, to, bodies);
}

function walkable(clear: (point: Point) => boolean, from: Point, to: Point, bodies: readonly Body[]): boolean {
  return everySample(from, to, clear) && clearOfBodies(from, to, bodies);
}

function clearOfBodies(from: Point, to: Point, bodies: readonly Body[]): boolean {
  const radius = bodies.some((body) => distance(from, body) < BODY_RADIUS + body.radius) ? RADIUS : BODY_RADIUS;
  return !bodiesBlockLine(from, to, radius, bodies);
}

function everySample(from: Point, to: Point, accept: (sample: Point) => boolean): boolean {
  const count = Math.max(1, Math.ceil(distance(from, to) / MOVE_SUBSTEP));
  for (let index = 1; index <= count; index += 1) {
    const sample = index === count ? to : { x: from.x + ((to.x - from.x) * index) / count, z: from.z + ((to.z - from.z) * index) / count };
    if (!accept(sample)) return false;
  }
  return true;
}

/** `isClear` over the collision cut into tiles, each holding only the features near it, so a call tests a handful. */
function tiledClearance(collision: SpaceCollision): (point: Point, radius: number) => boolean {
  const tiles = new Map<number, SpaceCollision>();
  return (point, radius) => {
    const tileX = Math.floor(point.x / TILE);
    const tileZ = Math.floor(point.z / TILE);
    const key = tileX * 65_536 + tileZ;
    let tile = tiles.get(key);
    if (tile === undefined) {
      tile = collisionNear(collision, { x: tileX * TILE, z: tileZ * TILE, width: TILE, depth: TILE }, TILE_REACH);
      tiles.set(key, tile);
    }
    return isClear(tile, point, radius);
  };
}

/** What a search runs over: the space's collision and the rasters of the sectors held so far. */
export interface PathGrid {
  collision: SpaceCollision;
  rasters: Iterable<WalkRaster>;
}

export interface FoundPath {
  /** The points to walk through in turn, the start left out; empty where the walker already stands as near as it can come. */
  waypoints: Point[];
  /** The path ends at the goal: at the point itself, moved out of any body's margin, or at the centre of its cell where the point cannot be stood on. */
  reached: boolean;
  /** The search stopped at `maxExpansions`, so the path ends at the nearest point toward the goal it had found by then. */
  capped: boolean;
  /** How many times the search ran again without an edge its legs could not take. */
  retries: number;
  /** How many cells the last search expanded. */
  expansions: number;
}

/**
 * A path from `from` toward `to` round the static world and `bodies` (the NPCs, monsters, and other
 * players as they stand), searched within the start and the goal plus `windowMargin`. A goal where
 * the walker would overlap a body or come within `bodyMargin` of it is moved to the nearest point
 * outside every body's margin. Where the goal cannot be reached, the path ends at the expanded cell
 * nearest it, the nearest point toward it the walker can reach in that window.
 * `excludedEdges` holds the edges a walk found unwalkable; the search leaves them out and adds any
 * it finds, so a walk passes the same set to every re-plan.
 */
export function findPath(grid: PathGrid, from: Point, to: Point, bodies: readonly Body[], excludedEdges: Set<string>): FoundPath {
  const near = bodies.filter((body) => distance(body, from) <= PATHFINDING.bodyRange);
  const goal = outsideBodies(to, near, from);
  const window = searchWindow(grid.rasters, from, goal);
  const clear = tiledClearance(grid.collision);
  const leg = (a: Point, b: Point): boolean => walkable((point) => clear(point, RADIUS), a, b, near);
  for (let retries = 0; ; retries += 1) {
    const search = searchCells(window, from, goal, near, excludedEdges, leg);
    const pulled = pullString(from, search.nodes, leg);
    if (pulled.unwalkable === undefined || retries === PATHFINDING.maxRetries) {
      return {
        waypoints: pulled.waypoints,
        reached: search.reached && pulled.unwalkable === undefined,
        capped: search.capped,
        retries,
        expansions: search.expansions,
      };
    }
    excludedEdges.add(pulled.unwalkable);
  }
}

/** How near the goal an expanded cell lies that a search tries to reach it from by a leg, where its own cell is not reached. */
const GOAL_APPROACH = 1;
/** How far past the edge of a body's margin a goal inside it is moved, so rounding leaves it outside. */
const GOAL_CLEARANCE = 1e-9;

/** How far apart two points' distances from the goal may lie and still count as as near, so the one nearer the walker wins. */
const GOAL_TIE = 1e-9;

/**
 * The nearest point to the goal outside the margin round every body. A goal inside margins is moved
 * to just past the edge of one, straight out from its body, or to just past where the edges of two
 * meet, since the nearest point outside them all lies on one of those. Of points as near the goal,
 * the one nearest the walker at `from` wins. A goal at a body's very centre, as a walk toward that
 * body heads, lies as near every point of its edge. So it is moved straight out toward the walker
 * wherever that point lies outside every margin, whatever bodies stand beside it. Where no such
 * point lies outside every margin, the goal stays as it is, and the path ends at the cell nearest it.
 */
function outsideBodies(to: Point, bodies: readonly Body[], from: Point): Point {
  if (outsideMargins(to, bodies)) return to;
  const edge = (body: Body): number => BODY_RADIUS + body.radius + GOAL_CLEARANCE;
  let goal = to;
  let nearest = Number.POSITIVE_INFINITY;
  for (const [index, body] of bodies.entries()) {
    const out = distance(to, body) === 0 ? from : to;
    const away = distance(out, body);
    const straightOut = away === 0 ? [] : [{ x: body.x + ((out.x - body.x) * edge(body)) / away, z: body.z + ((out.z - body.z) * edge(body)) / away }];
    const crossings = bodies.slice(index + 1).flatMap((other) => edgeCrossings(body, edge(body), other, edge(other)));
    for (const candidate of [...straightOut, ...crossings]) {
      const moved = distance(to, candidate);
      if (moved > nearest + GOAL_TIE || !outsideMargins(candidate, bodies)) continue;
      if (moved >= nearest - GOAL_TIE && distance(candidate, from) >= distance(goal, from)) continue;
      goal = candidate;
      nearest = Math.min(nearest, moved);
    }
  }
  return goal;
}

/** Whether the point lies outside the margin round every body. */
function outsideMargins(point: Point, bodies: readonly Body[]): boolean {
  return bodies.every((body) => distance(point, body) >= BODY_RADIUS + body.radius);
}

/** Where the circles of the given radii round the two centres cross, none where they do not. */
function edgeCrossings(a: Point, aRadius: number, b: Point, bRadius: number): Point[] {
  const apart = distance(a, b);
  if (apart >= aRadius + bRadius || apart <= Math.abs(aRadius - bRadius)) return [];
  const along = (apart * apart + aRadius * aRadius - bRadius * bRadius) / (2 * apart);
  const across = Math.sqrt(aRadius * aRadius - along * along);
  const x = (b.x - a.x) / apart;
  const z = (b.z - a.z) / apart;
  const middle = { x: a.x + x * along, z: a.z + z * along };
  return [
    { x: middle.x - z * across, z: middle.z + x * across },
    { x: middle.x + z * across, z: middle.z - x * across },
  ];
}

interface Cell {
  column: number;
  row: number;
}

interface PathNode extends Cell {
  point: Point;
}

/** The cells a search may expand, with the bits of the rasters that cover them. */
interface SearchWindow extends Cell {
  columns: number;
  rows: number;
  cells: Uint8Array;
}

function searchWindow(rasters: Iterable<WalkRaster>, from: Point, to: Point): SearchWindow {
  const margin = PATHFINDING.windowMargin;
  const column = firstCell(Math.min(from.x, to.x) - margin);
  const row = firstCell(Math.min(from.z, to.z) - margin);
  const columns = firstCell(Math.max(from.x, to.x) + margin) - column;
  const rows = firstCell(Math.max(from.z, to.z) + margin) - row;
  const cells = new Uint8Array(columns * rows);
  for (const raster of rasters) {
    const left = Math.max(column, raster.column);
    const right = Math.min(column + columns, raster.column + raster.columns);
    if (left >= right) continue;
    for (let at = Math.max(row, raster.row); at < Math.min(row + rows, raster.row + raster.rows); at += 1) {
      const source = (at - raster.row) * raster.columns - raster.column;
      cells.set(raster.cells.subarray(source + left, source + right), (at - row) * columns + left - column);
    }
  }
  return { column, row, columns, rows, cells };
}

/**
 * A* from the start point over the window's cells. The start steps by `leg` to its own cell and the
 * eight round it. A cell steps to a neighbour where its raster's edge bit allows and `leg`'s rule
 * leaves the step clear of the bodies. A diagonal step also needs both cells beside it clear. The
 * nodes run from the first cell to the goal's cell, or where that cell is not reached to the
 * expanded cell nearest the goal. They end at the goal itself where its cell is clear in the raster,
 * it lies outside every body's margin, and `leg` reaches it: from the goal's cell where that was
 * reached, and otherwise from whichever of the start, the expanded cell nearest it, and the
 * expanded cells within `GOAL_APPROACH` of it lies nearest it with a `leg` to it. So a goal whose
 * cell a body's disk covers is still reached. So is one in the notch where two disks meet: a leg
 * reaches it only from outside both, and from the start where no cell near it lies outside them.
 */
function searchCells(
  window: SearchWindow,
  from: Point,
  to: Point,
  bodies: readonly Body[],
  excludedEdges: ReadonlySet<string>,
  leg: (a: Point, b: Point) => boolean,
): { nodes: PathNode[]; reached: boolean; capped: boolean; expansions: number } {
  const { columns, rows, cells } = window;
  const start = -1;
  const cost = new Float64Array(columns * rows).fill(Infinity);
  const parent = new Int32Array(columns * rows);
  const closed = new Uint8Array(columns * rows);
  const open = new CellHeap();
  const cellAt = (index: number): Cell => ({ column: window.column + (index % columns), row: window.row + Math.floor(index / columns) });
  const centreOf = (index: number): Point => {
    const cell = cellAt(index);
    return cellCentre(cell.column, cell.row);
  };
  const goalColumn = cellIndex(to.x) - window.column;
  const goalRow = cellIndex(to.z) - window.row;
  const goal = goalRow * columns + goalColumn;
  const heuristic = (index: number): number => {
    const across = Math.abs((index % columns) - goalColumn);
    const down = Math.abs(Math.floor(index / columns) - goalRow);
    return (Math.max(across, down) + (Math.SQRT2 - 1) * Math.min(across, down)) * PATHFINDING.cell;
  };
  const excluded = (a: Cell, b: Cell): boolean => excludedEdges.size > 0 && excludedEdges.has(edgeKey(a, b));

  const startCell = { column: cellIndex(from.x), row: cellIndex(from.z) };
  for (let row = -1; row <= 1; row += 1) {
    for (let column = -1; column <= 1; column += 1) {
      const index = (startCell.row - window.row + row) * columns + startCell.column - window.column + column;
      if ((cells[index]! & CLEAR) === 0 || excluded(startCell, cellAt(index))) continue;
      const centre = centreOf(index);
      if (!leg(from, centre)) continue;
      cost[index] = distance(from, centre);
      parent[index] = start;
      open.push(index, cost[index] + heuristic(index));
    }
  }

  let best = start;
  let bestDistance = distance(from, to);
  let expansions = 0;
  let reached = false;
  let capped = false;
  while (open.size > 0) {
    const index = open.pop();
    if (closed[index] === 1) continue;
    if (expansions === PATHFINDING.maxExpansions) {
      capped = true;
      break;
    }
    closed[index] = 1;
    expansions += 1;
    const centre = centreOf(index);
    const away = distance(centre, to);
    if (away < bestDistance) {
      best = index;
      bestDistance = away;
    }
    if (index === goal) {
      reached = true;
      break;
    }
    const column = index % columns;
    const row = Math.floor(index / columns);
    for (const step of STEPS) {
      const nextColumn = column + step.column;
      const nextRow = row + step.row;
      if (nextColumn < 0 || nextRow < 0 || nextColumn >= columns || nextRow >= rows) continue;
      const next = nextRow * columns + nextColumn;
      if (closed[next] === 1 || (cells[step.heldHere ? index : next]! & step.bit) === 0) continue;
      if (step.column !== 0 && step.row !== 0 && ((cells[row * columns + nextColumn]! & CLEAR) === 0 || (cells[nextRow * columns + column]! & CLEAR) === 0))
        continue;
      const nextCost = cost[index]! + step.cost;
      if (nextCost >= cost[next]! || excluded(cellAt(index), cellAt(next)) || !clearOfBodies(centre, centreOf(next), bodies)) continue;
      cost[next] = nextCost;
      parent[next] = index;
      open.push(next, nextCost + heuristic(next));
    }
  }

  const pointOf = (index: number): Point => (index === start ? from : centreOf(index));
  let end = reached ? goal : best;
  let arrives = false;
  if (expansions > 0 && (cells[goal]! & CLEAR) !== 0 && outsideMargins(to, bodies)) {
    const approaches = reached ? [goal] : best === start ? [start] : [start, best];
    if (!reached) {
      const span = Math.ceil(GOAL_APPROACH / PATHFINDING.cell);
      for (let row = Math.max(0, goalRow - span); row <= Math.min(rows - 1, goalRow + span); row += 1) {
        for (let column = Math.max(0, goalColumn - span); column <= Math.min(columns - 1, goalColumn + span); column += 1) {
          const index = row * columns + column;
          if (closed[index] === 1 && index !== best && distance(centreOf(index), to) <= GOAL_APPROACH) approaches.push(index);
        }
      }
      approaches.sort((a, b) => distance(pointOf(a), to) - distance(pointOf(b), to));
    }
    const approach = approaches.find((index) => leg(pointOf(index), to));
    if (approach !== undefined) {
      end = approach;
      arrives = true;
    }
  }
  const nodes: PathNode[] = [];
  for (let index = end; index !== start; index = parent[index]!) nodes.push({ ...cellAt(index), point: centreOf(index) });
  nodes.reverse();
  if (arrives) {
    nodes.push({ ...cellAt(goal), point: to });
    reached = true;
  }
  return { nodes, reached, capped, expansions };
}

/**
 * The nodes as a handful of legs: from each anchor, the leg to the furthest later node `leg` can
 * take. Where it takes not even the next, that edge is what the search must run again without.
 */
function pullString(from: Point, nodes: readonly PathNode[], leg: (a: Point, b: Point) => boolean): { waypoints: Point[]; unwalkable?: string } {
  const waypoints: Point[] = [];
  let anchor: PathNode = { column: cellIndex(from.x), row: cellIndex(from.z), point: from };
  let index = 0;
  while (index < nodes.length) {
    let next = nodes.length - 1;
    while (next >= index && !leg(anchor.point, nodes[next]!.point)) next -= 1;
    if (next < index) return { waypoints, unwalkable: edgeKey(anchor, nodes[index]!) };
    anchor = nodes[next]!;
    waypoints.push(anchor.point);
    index = next + 1;
  }
  return { waypoints };
}

function edgeKey(a: Cell, b: Cell): string {
  const [first, second] = a.row < b.row || (a.row === b.row && a.column <= b.column) ? [a, b] : [b, a];
  return `${first.column},${first.row}:${second.column},${second.row}`;
}

/** The cell holding the coordinate. */
function cellIndex(at: number): number {
  return Math.floor(at / PATHFINDING.cell);
}

/** The first cell whose centre lies at or past the coordinate. */
function firstCell(at: number): number {
  return Math.ceil(at / PATHFINDING.cell - 0.5);
}

function cellCentre(column: number, row: number): Point {
  return { x: (column + 0.5) * PATHFINDING.cell, z: (row + 0.5) * PATHFINDING.cell };
}

/** The open cells of a search, the lowest estimate first. */
class CellHeap {
  private readonly indices: number[] = [];
  private readonly estimates: number[] = [];

  get size(): number {
    return this.indices.length;
  }

  push(index: number, estimate: number): void {
    let at = this.indices.length;
    this.indices.push(index);
    this.estimates.push(estimate);
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (this.estimates[parent]! <= estimate) break;
      this.indices[at] = this.indices[parent]!;
      this.estimates[at] = this.estimates[parent]!;
      at = parent;
    }
    this.indices[at] = index;
    this.estimates[at] = estimate;
  }

  pop(): number {
    const top = this.indices[0]!;
    const index = this.indices.pop()!;
    const estimate = this.estimates.pop()!;
    const size = this.indices.length;
    if (size === 0) return top;
    let at = 0;
    for (;;) {
      const left = 2 * at + 1;
      if (left >= size) break;
      const child = left + 1 < size && this.estimates[left + 1]! < this.estimates[left]! ? left + 1 : left;
      if (this.estimates[child]! >= estimate) break;
      this.indices[at] = this.indices[child]!;
      this.estimates[at] = this.estimates[child]!;
      at = child;
    }
    this.indices[at] = index;
    this.estimates[at] = estimate;
    return top;
  }
}
