import type { Blocker } from '@somnio/protocol';
import { describe, expect, it } from 'vitest';
import { buildSpaceCollision, canStand, collisionNear, isClear, npcBodies, resolveMove } from '../src/collision.ts';
import type { Body, SpaceCollision } from '../src/collision.ts';
import { SOMNIO_CONSTANTS } from '../src/constants.ts';
import { distance } from '../src/geometry.ts';
import type { Point, Rect } from '../src/geometry.ts';
import { hashString, seededSequence } from '../src/hash.ts';
import { bundledModelRegistry } from '../src/modelRegistry.ts';
import { PATHFINDING, findPath, legWalkable, rasterizeWalkable, walkRasterInputs } from '../src/pathfinding.ts';
import type { FoundPath, PathGrid } from '../src/pathfinding.ts';
import { sectorRect } from '../src/sector.ts';
import type { Sector } from '../src/sector.ts';
import { buildWorld, resolveDoor } from '../src/world.ts';
import { loadSectorFixtures } from './support/sectorFixture.ts';
import { TEST_REGISTRY, outdoorSector } from './support/worldFixture.ts';

const RADIUS = SOMNIO_CONSTANTS.playerRadius;
const CELL = PATHFINDING.cell;
const BUNDLED = bundledModelRegistry();
const WORLD = buildWorld(loadSectorFixtures(), BUNDLED);

interface Space {
  grid: PathGrid & { rasters: ReturnType<typeof rasterizeWalkable>[] };
  collision: SpaceCollision;
  npcs: Body[];
  sectors: Sector[];
}

const spaces = new Map<string, Space>();

/** A committed space with every sector rasterized, its NPCs as the bodies a search plans round. */
function committed(spaceId: string): Space {
  let space = spaces.get(spaceId);
  if (space === undefined) {
    const held = WORLD.spaces.get(spaceId)!;
    const collision = buildSpaceCollision(held, BUNDLED);
    space = {
      grid: { collision, rasters: held.sectors.map((sector) => rasterizeWalkable(walkRasterInputs(collision, sector))) },
      collision,
      npcs: npcBodies(held),
      sectors: held.sectors,
    };
    spaces.set(spaceId, space);
  }
  return space;
}

/** One 20 m outdoor sector holding the given blockers, rasterized. */
function field(blockers: Blocker[] = []): Space {
  const sector = outdoorSector('Field', { x: 0, z: 0 }, { blockers });
  const collision = buildSpaceCollision({ id: 'outdoors', sectors: [sector] }, TEST_REGISTRY);
  return { grid: { collision, rasters: [rasterizeWalkable(walkRasterInputs(collision, sector))] }, collision, npcs: [], sectors: [sector] };
}

function blocker(id: string, x: number, z: number, width: number, depth: number): Blocker {
  return { id, x, z, width, depth };
}

function search(space: Space, from: Point, to: Point, bodies: Body[] = space.npcs): FoundPath {
  return findPath(space.grid, from, to, bodies, new Set());
}

/** Walks the path leg by leg as the follower will, through `resolveMove`, and returns where the walker ends. */
function walk(space: Space, from: Point, path: FoundPath, bodies: Body[] = []): Point {
  let at = from;
  for (const waypoint of path.waypoints) {
    const moved = resolveMove(space.collision, at, waypoint, RADIUS, space.npcs, bodies);
    expect(moved.blocked, `the leg from (${at.x}, ${at.z}) to (${waypoint.x}, ${waypoint.z})`).toBe(false);
    at = moved.position;
  }
  return at;
}

function legs(from: Point, path: FoundPath): [Point, Point][] {
  return path.waypoints.map((waypoint, index) => [index === 0 ? from : path.waypoints[index - 1]!, waypoint]);
}

function centreOfCell(point: Point): Point {
  return cellCentre(Math.floor(point.x / CELL), Math.floor(point.z / CELL));
}

describe('known routes through the committed world', () => {
  const square = WORLD.spaces.get('outdoors')!.sectors.find((sector) => sector.name === 'EdariaSquare')!;
  const libraryDoor = resolveDoor(
    square,
    square.doors.find((door) => door.id === 'to-edarialibrary')!,
    BUNDLED,
  )!;
  const routes: { name: string; space: string; from: Point; to: Point }[] = [
    { name: 'from the Library door to the well', space: 'outdoors', from: libraryDoor.arrival, to: { x: 20.5, z: 22.5 } },
    { name: 'from the square through the north gate into the North Meadow', space: 'outdoors', from: { x: 20.5, z: 23 }, to: { x: 20, z: -10 } },
    { name: 'across the inn round its table', space: 'EdariaInn', from: { x: 6.4, z: 2 }, to: { x: 1.75, z: 7.2 } },
    { name: 'round the townhall', space: 'outdoors', from: { x: 31.5, z: 2 }, to: { x: 38, z: 9.5 } },
  ];

  it.each(routes)('reaches the goal $name and walks there', ({ space: spaceId, from, to }) => {
    const space = committed(spaceId);
    expect(canStand(space.collision, to, space.npcs)).toBe(true);

    const path = search(space, from, to);

    expect(path.reached).toBe(true);
    expect(path.waypoints.at(-1)).toEqual(to);
    expect(distance(walk(space, from, path), to)).toBeLessThan(1e-9);
  });

  it('crosses the border between the square and the North Meadow on cells that line up', () => {
    const space = committed('outdoors');
    const square = space.grid.rasters.find((raster) => raster.sector === 'EdariaSquare')!;
    const meadow = space.grid.rasters.find((raster) => raster.sector === 'NorthMeadow')!;
    expect(meadow.row + meadow.rows - square.row).toBe(0);

    const from = { x: 20.5, z: 3 };
    const path = search(space, from, { x: 20.5, z: -3 });

    expect(path.reached).toBe(true);
    expect(path.waypoints).toEqual([{ x: 20.5, z: -3 }]);
    expect(distance(walk(space, from, path), { x: 20.5, z: -3 })).toBeLessThan(1e-9);
  });

  it('ends a tap in the middle of the townhall at a reachable point beside it', () => {
    const space = committed('outdoors');
    const from = { x: 31.5, z: 4 };
    const inside = { x: 37.2, z: 4 };

    const path = search(space, from, inside);

    expect(path.reached).toBe(false);
    const end = walk(space, from, path);
    expect(canStand(space.collision, end, space.npcs)).toBe(true);
    expect(distance(end, inside)).toBeLessThan(distance(from, inside));
  });

  it('bounds the work of a search for a goal it cannot reach by the expansion cap', () => {
    const space = committed('outdoors');
    const from = { x: 20.5, z: 23 };

    const path = search(space, from, { x: 120, z: 120 });

    expect(path.capped).toBe(true);
    expect(path.expansions).toBe(PATHFINDING.maxExpansions);
    expect(path.reached).toBe(false);
    for (const [start, end] of legs(from, path)) expect(legWalkable(space.collision, start, end, [])).toBe(true);
  });
});

/**
 * Whether each goal is reachable, judged apart from the search: a flood fill from the start over the
 * same graph (the start to the nine cells round it, a cell to its eight neighbours, a diagonal only
 * between clear cells) with every edge judged by `legWalkable` itself rather than by the rasters,
 * inside the same window.
 */
class FloodFill {
  private readonly space: Space;
  private readonly clearCells = new Map<string, boolean>();
  private readonly clearEdges = new Map<string, boolean>();
  private readonly tiles = new Map<string, SpaceCollision>();

  constructor(space: Space) {
    this.space = space;
  }

  /** The centres of the cells reachable from the start within the window of the start and the goal. */
  reachable(from: Point, to: Point): Map<string, Point> {
    const margin = PATHFINDING.windowMargin;
    const firstCell = (at: number): number => Math.ceil(at / CELL - 0.5);
    const columns = [firstCell(Math.min(from.x, to.x) - margin), firstCell(Math.max(from.x, to.x) + margin)] as const;
    const rows = [firstCell(Math.min(from.z, to.z) - margin), firstCell(Math.max(from.z, to.z) + margin)] as const;
    const reachable = new Map<string, Point>();
    const queue: [number, number][] = [];
    const enter = (column: number, row: number): void => {
      reachable.set(`${column},${row}`, cellCentre(column, row));
      queue.push([column, row]);
    };
    const startColumn = Math.floor(from.x / CELL);
    const startRow = Math.floor(from.z / CELL);
    for (let row = startRow - 1; row <= startRow + 1; row += 1) {
      for (let column = startColumn - 1; column <= startColumn + 1; column += 1) {
        if (this.clearCell(column, row) && legWalkable(this.space.collision, from, cellCentre(column, row), this.space.npcs)) enter(column, row);
      }
    }
    while (queue.length > 0) {
      const [column, row] = queue.pop()!;
      for (const [across, down] of NEIGHBOURS) {
        const nextColumn = column + across;
        const nextRow = row + down;
        if (nextColumn < columns[0] || nextColumn >= columns[1] || nextRow < rows[0] || nextRow >= rows[1] || reachable.has(`${nextColumn},${nextRow}`))
          continue;
        if (!this.clearCell(nextColumn, nextRow)) continue;
        if (across !== 0 && down !== 0 && (!this.clearCell(nextColumn, row) || !this.clearCell(column, nextRow))) continue;
        if (this.clearEdge(column, row, nextColumn, nextRow)) enter(nextColumn, nextRow);
      }
    }
    return reachable;
  }

  /** Whether the cell is one a raster holds, its centre in a sector's rect, and a body is clear there. */
  private clearCell(column: number, row: number): boolean {
    const key = `${column},${row}`;
    let clear = this.clearCells.get(key);
    if (clear === undefined) {
      const centre = cellCentre(column, row);
      clear = this.space.sectors.some((sector) => inHalfOpen(sectorRect(sector), centre)) && isClear(this.tile(centre), centre, RADIUS);
      this.clearCells.set(key, clear);
    }
    return clear;
  }

  /** `legWalkable` between two neighbouring cells, judged once per edge over the features near it. */
  private clearEdge(column: number, row: number, nextColumn: number, nextRow: number): boolean {
    const from = cellCentre(column, row);
    const to = cellCentre(nextColumn, nextRow);
    const key = `${column},${row}:${nextColumn},${nextRow}`;
    let clear = this.clearEdges.get(key);
    if (clear === undefined) {
      clear = legWalkable(this.tile(from), from, to, this.space.npcs);
      this.clearEdges.set(key, clear);
    }
    return clear;
  }

  /** The features a body within a diagonal of a point in the point's 2 m tile can touch. */
  private tile(point: Point): SpaceCollision {
    const x = Math.floor(point.x / 2) * 2;
    const z = Math.floor(point.z / 2) * 2;
    const key = `${x},${z}`;
    let tile = this.tiles.get(key);
    if (tile === undefined) {
      tile = collisionNear(this.space.collision, { x, z, width: 2, depth: 2 }, RADIUS + CELL * Math.SQRT2);
      this.tiles.set(key, tile);
    }
    return tile;
  }
}

const NEIGHBOURS = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
] as const;

function cellCentre(column: number, row: number): Point {
  return { x: (column + 0.5) * CELL, z: (row + 0.5) * CELL };
}

function inHalfOpen(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.x < rect.x + rect.width && point.z >= rect.z && point.z < rect.z + rect.depth;
}

describe('the search against a flood fill over the same edge rule', () => {
  const QUERIES_PER_SPACE = 150;

  it.each([...WORLD.spaces.keys()])(
    'reaches every goal the flood fill reaches in %s, and otherwise ends nearest it',
    (spaceId) => {
      const space = committed(spaceId);
      const flood = new FloodFill(space);
      const random = seededSequence(hashString(`pathfinding ${spaceId}`));
      let queries = 0;
      let reached = 0;
      while (queries < QUERIES_PER_SPACE) {
        const sector = space.sectors[Math.floor(random() * space.sectors.length)]!;
        const rect = sectorRect(sector);
        const from = { x: rect.x + random() * rect.width, z: rect.z + random() * rect.depth };
        if (!canStand(space.collision, from, space.npcs)) continue;
        const angle = random() * 2 * Math.PI;
        const reach = random() * Math.min(14, Math.max(rect.width, rect.depth));
        const to = { x: from.x + Math.cos(angle) * reach, z: from.z + Math.sin(angle) * reach };
        queries += 1;

        const path = search(space, from, to);
        for (const [start, end] of legs(from, path)) expect(legWalkable(space.collision, start, end, space.npcs)).toBe(true);
        expect(path.capped).toBe(false);
        expect(path.retries).toBe(0);

        const reachable = flood.reachable(from, to);
        const goalCell = `${Math.floor(to.x / CELL)},${Math.floor(to.z / CELL)}`;
        const end = path.waypoints.at(-1) ?? from;
        const goalCentre = reachable.get(goalCell);
        if (goalCentre !== undefined) {
          reached += 1;
          expect(path.reached).toBe(true);
          const standable =
            space.npcs.every((npc) => distance(to, npc) >= RADIUS + PATHFINDING.bodyMargin + npc.radius) &&
            legWalkable(space.collision, goalCentre, to, space.npcs);
          expect(end).toEqual(standable ? to : goalCentre);
        } else {
          expect(path.reached).toBe(false);
          const nearest = Math.min(distance(from, to), ...[...reachable.values()].map((centre) => distance(centre, to)));
          expect(distance(end, to)).toBeCloseTo(nearest, 9);
        }
      }
      expect(reached).toBeGreaterThan(0);
    },
    // Outdoors the flood fill alone takes a couple of seconds, past the default timeout on a busy runner.
    30_000,
  );
});

describe('the edge rule', () => {
  it('never takes a gap narrower than a body between two clear cells, and goes round it', () => {
    // Two thin walls on one line leave a 0.55 m gap, with the cells either side of the line clear.
    const space = field([blocker('west', 2, 10, 7.85, 0.004), blocker('east', 10.4, 10, 7.6, 0.004)]);
    const below = { x: 10.125, z: 9.875 };
    const above = { x: 10.125, z: 10.125 };
    expect(isClear(space.collision, below, RADIUS) && isClear(space.collision, above, RADIUS)).toBe(true);
    const from = { x: 10.125, z: 8 };
    const to = { x: 10.125, z: 12 };

    const path = search(space, from, to);

    expect(path.reached).toBe(true);
    expect(path.retries).toBe(0);
    for (const [start, end] of legs(from, path)) {
      const crossing = start.x + ((end.x - start.x) * (10 - start.z)) / (end.z - start.z);
      if ((start.z - 10) * (end.z - 10) < 0) expect(crossing < 2 || crossing > 18).toBe(true);
    }
    expect(distance(walk(space, from, path), to)).toBeLessThan(1e-9);
  });

  it('leaves an arrival point another dreamer shares', () => {
    const space = field();
    const shared = { x: 10, z: 10 };
    const dreamer = { ...shared, radius: RADIUS };
    const to = { x: 13, z: 10.4 };

    const path = search(space, shared, to, [dreamer]);

    expect(path.reached).toBe(true);
    expect(path.waypoints.at(-1)).toEqual(to);
    expect(distance(walk(space, shared, path, [dreamer]), to)).toBeLessThan(1e-9);
  });

  it('ends a tap a few centimetres from a wall face at the centre of its cell, without running again', () => {
    const space = field([blocker('wall', 10.18, 5, 1, 10)]);
    const to = { x: 9.99, z: 8.1 };
    expect(canStand(space.collision, to, [])).toBe(false);

    const path = search(space, { x: 5, z: 8.1 }, to);

    expect(path.reached).toBe(true);
    expect(path.retries).toBe(0);
    expect(path.waypoints.at(-1)).toEqual(centreOfCell(to));
  });

  it('takes one straight leg between any two points of an open room', () => {
    const space = field();
    const random = seededSequence(hashString('open room'));
    for (let query = 0; query < 20; query += 1) {
      const from = { x: 0.5 + random() * 19, z: 0.5 + random() * 19 };
      const to = { x: 0.5 + random() * 19, z: 0.5 + random() * 19 };

      expect(search(space, from, to).waypoints).toEqual([to]);
    }
  });

  /** A leg through the body's centre nears it before leaving, which the follower's substeps refuse, so the path leaves the other way. */
  it('walks out of a body it overlaps only away from its centre, and still arrives', () => {
    const space = field();
    const body = { x: 10, z: 10, radius: SOMNIO_CONSTANTS.playerRadius };
    const from = { x: 10.01, z: 10 };
    const to = { x: 9, z: 10 };

    expect(legWalkable(space.collision, from, to, [body])).toBe(false);
    expect(legWalkable(space.collision, from, { x: 11, z: 10 }, [body])).toBe(true);
    const path = search(space, from, to, [body]);
    expect(path.reached).toBe(true);
    expect(distance(walk(space, from, path, [body]), to)).toBeLessThan(1e-9);
  });

  /** Each leg runs along `z = lineZ`, which passes the body's centre within contact plus the margin but not within contact. */
  describe('keeps the margin from a body only where a leg starts clear of it by the margin', () => {
    const body = { x: 10, z: 10, radius: RADIUS };
    const lineZ = body.z + RADIUS + body.radius + PATHFINDING.bodyMargin / 2;

    it('lets a leg starting within the margin pass by in contact', () => {
      const from = { x: body.x - 0.15, z: lineZ };
      expect(distance(from, body)).toBeLessThan(RADIUS + body.radius + PATHFINDING.bodyMargin);

      expect(legWalkable(field().collision, from, { x: 15, z: lineZ }, [body])).toBe(true);
    });

    it('refuses a leg starting clear of it that would pass within the margin', () => {
      const space = field();
      const from = { x: body.x - 3, z: lineZ };
      const to = { x: body.x + 3, z: lineZ };

      expect(legWalkable(space.collision, from, to, [body])).toBe(false);
      expect(search(space, from, to, [body]).waypoints).not.toEqual([to]);
    });
  });

  /**
   * Every leg but one square across their line nears one of the two centres, so a rule judging each
   * body alone leaves almost no way out. Just clear of them, within the margin, a leg toward either
   * would come into contact.
   */
  it.each([
    { name: 'it overlaps', offset: 0.08 },
    { name: 'it is just clear of', offset: 0.61 },
  ])('walks out from between two bodies $name on opposite sides, and arrives', ({ offset }) => {
    const space = committed('EdariaArena');
    const from = { x: 2.882, z: 3.375 };
    const to = { x: 9, z: 3.4 };
    const bodies = [-offset, offset].map((along) => ({ x: from.x + along, z: from.z, radius: RADIUS }));

    const path = search(space, from, to, bodies);

    expect(path.reached).toBe(true);
    expect(distance(walk(space, from, path, bodies), to)).toBeLessThan(1e-9);
  });

  it('plans round a body standing on the line and still arrives', () => {
    const space = field();
    const from = { x: 5, z: 10 };
    const to = { x: 15, z: 10 };
    const body = { x: 10, z: 10, radius: SOMNIO_CONSTANTS.npcRadius };

    const path = search(space, from, to, [body]);

    expect(path.reached).toBe(true);
    expect(path.waypoints.length).toBeGreaterThan(1);
    for (const [start, end] of legs(from, path)) {
      for (let sample = 0; sample <= 100; sample += 1) {
        const at = { x: start.x + ((end.x - start.x) * sample) / 100, z: start.z + ((end.z - start.z) * sample) / 100 };
        expect(distance(at, body)).toBeGreaterThanOrEqual(RADIUS + body.radius);
      }
    }
    expect(distance(walk(space, from, path, [body]), to)).toBeLessThan(1e-9);
  });

  it('leaves out an edge a leg could not take where the rasters are older than the collision, and keeps it out across re-plans', () => {
    const open = field();
    const post = field([blocker('post', 9.9, 9.9, 0.2, 0.2)]);
    const grid = { collision: post.collision, rasters: open.grid.rasters };
    const from = { x: 5, z: 10 };
    const to = { x: 15, z: 10 };
    const excluded = new Set<string>();

    const first = findPath(grid, from, to, [], excluded);
    expect(first.retries).toBe(PATHFINDING.maxRetries);
    expect(first.reached).toBe(false);
    expect(excluded.size).toBe(PATHFINDING.maxRetries);

    let path = first;
    for (let replan = 0; replan < 4 && !path.reached; replan += 1) {
      path = findPath(grid, from, to, [], excluded);
      for (const [start, end] of legs(from, path)) expect(legWalkable(post.collision, start, end, [])).toBe(true);
    }
    expect(path.reached).toBe(true);
    expect(distance(walk(post, from, path), to)).toBeLessThan(1e-9);
  });
});
