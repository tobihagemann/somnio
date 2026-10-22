import type { Blocker, Placement } from '@somnio/protocol';
import { describe, expect, it } from 'vitest';
import {
  MOVE_SUBSTEP,
  bodyBlocks,
  buildSpaceCollision,
  canStand,
  groundHeightAt,
  isClear,
  isLegalMove,
  npcBodies,
  resolveMove,
  walkSurfaceLedges,
} from '../src/collision.ts';
import type { Body, SpaceCollision } from '../src/collision.ts';
import { SOMNIO_CONSTANTS } from '../src/constants.ts';
import { distance, modelToWorld, worldToModel } from '../src/geometry.ts';
import type { Point, Segment } from '../src/geometry.ts';
import { hashString, seededSequence } from '../src/hash.ts';
import { bundledModelRegistry, objectModel } from '../src/modelRegistry.ts';
import { sectorRect } from '../src/sector.ts';
import { buildWorld, doorContains, resolveDoor } from '../src/world.ts';
import { loadSectorFixtures } from './support/sectorFixture.ts';
import { TEST_REGISTRY, outdoorSector } from './support/worldFixture.ts';

const RADIUS = SOMNIO_CONSTANTS.playerRadius;
const BUNDLED = bundledModelRegistry();

function placement(id: string, modelId: string, x: number, z: number, yaw = 0, elevation = 0): Placement {
  return { id, modelId, x, z, yaw, elevation };
}

function blocker(id: string, x: number, z: number, width: number, depth: number): Blocker {
  return { id, x, z, width, depth };
}

/** One 20 m outdoor sector at the origin holding the given records. */
function field(placements: Placement[] = [], blockers: Blocker[] = []): SpaceCollision {
  return buildSpaceCollision({ id: 'outdoors', sectors: [outdoorSector('Field', { x: 0, z: 0 }, { placements, blockers })] }, TEST_REGISTRY);
}

/** The same field over the committed registry, for the real buildings' geometry. */
function bundledField(placements: Placement[]): SpaceCollision {
  return buildSpaceCollision({ id: 'outdoors', sectors: [outdoorSector('Field', { x: 0, z: 0 }, { placements })] }, BUNDLED);
}

/** Steps of `MOVE_SUBSTEP`, the longest the predictor takes, from `from` along the unit `direction`. */
function walk(collision: SpaceCollision, from: Point, direction: Point, steps: number, npcs: Body[] = [], bodies: Body[] = []): Point[] {
  const path = [from];
  for (let step = 0; step < steps; step += 1) {
    const at = path.at(-1)!;
    path.push(resolveMove(collision, at, { x: at.x + direction.x * MOVE_SUBSTEP, z: at.z + direction.z * MOVE_SUBSTEP }, RADIUS, npcs, bodies).position);
  }
  return path;
}

describe('clear and blocked points', () => {
  it('blocks inside a blocker and within a radius of it, and counts contact as clear', () => {
    const collision = field([], [blocker('wall', 10, 0, 1, 20)]);
    expect(isClear(collision, { x: 10.5, z: 5 }, RADIUS)).toBe(false);
    expect(isClear(collision, { x: 9.71, z: 5 }, RADIUS)).toBe(false);
    expect(isClear(collision, { x: 9.7, z: 5 }, RADIUS)).toBe(true);
  });

  it('blocks on a placed model by its footprint with no blocker record', () => {
    const collision = field([placement('box-1', 'box', 10, 10)]);
    expect(isClear(collision, { x: 10.9, z: 10.4 }, RADIUS)).toBe(false);
    expect(isClear(collision, { x: 11.29, z: 10 }, RADIUS)).toBe(false);
    expect(isClear(collision, { x: 11.3, z: 10 }, RADIUS)).toBe(true);
  });

  it('never blocks on a model with an empty collider list', () => {
    expect(isClear(field([placement('rug-1', 'rug', 10, 10)]), { x: 10, z: 10 }, RADIUS)).toBe(true);
  });

  it('reports an unmapped model and lets bodies through it', () => {
    const collision = field([placement('ghost-1', 'not-a-model', 10, 10)]);
    expect(collision.issues).toEqual([{ sector: 'Field', record: 'placement', id: 'ghost-1', message: expect.stringContaining('not in the registry') }]);
    expect(isClear(collision, { x: 10, z: 10 }, RADIUS)).toBe(true);
  });

  it('collides where a model at a non-quarter yaw stands, not where it would stand unrotated', () => {
    const box = placement('box-1', 'box', 10, 10, 30);
    const collision = field([box]);
    // Inside the rotated box, outside the unrotated one.
    expect(isClear(collision, modelToWorld(box, { x: 0.9, z: -0.45 }), 0.1)).toBe(false);
    // Inside the unrotated box, outside the rotated one.
    expect(isClear(collision, { x: 10.9, z: 10.4 }, 0.1)).toBe(true);
  });
});

describe('the world edge', () => {
  const lone = field();

  it('blocks at a sector edge with no neighbour', () => {
    expect(isClear(lone, { x: 19.71, z: 10 }, RADIUS)).toBe(false);
    expect(isClear(lone, { x: 19.7, z: 10 }, RADIUS)).toBe(true);
    expect(isClear(lone, { x: 20.5, z: 10 }, RADIUS)).toBe(false);
  });

  it('opens the stretch of an edge a neighbour shares and keeps the rest closed', () => {
    const collision = buildSpaceCollision(
      { id: 'outdoors', sectors: [outdoorSector('West', { x: 0, z: 0 }), outdoorSector('East', { x: 20, z: 5 })] },
      TEST_REGISTRY,
    );
    expect(collision.edges).toContainEqual({ a: { x: 20, z: 0 }, b: { x: 20, z: 5 } });
    expect(collision.edges).toContainEqual({ a: { x: 20, z: 20 }, b: { x: 20, z: 25 } });
    expect(collision.edges).toHaveLength(8);
    expect(isClear(collision, { x: 19.9, z: 10 }, RADIUS)).toBe(true);
    expect(isClear(collision, { x: 19.9, z: 2 }, RADIUS)).toBe(false);
    expect(isLegalMove(collision, { x: 19, z: 10 }, { x: 21, z: 10 }, RADIUS, [])).toBe(true);
  });

  it('treats origins that miss each other by a rounding error as one edge', () => {
    // 5.12 + 30.72 is 35.839999999999996, a hair short of the neighbour's origin.
    const collision = buildSpaceCollision(
      { id: 'outdoors', sectors: [outdoorSector('West', { x: 5.12, z: 0 }, { size: { width: 30.72, depth: 20 } }), outdoorSector('East', { x: 35.84, z: 0 })] },
      TEST_REGISTRY,
    );
    expect(isLegalMove(collision, { x: 35, z: 10 }, { x: 36.5, z: 10 }, RADIUS, [])).toBe(true);
  });
});

describe('the slide', () => {
  it('follows a wall along the free axis and reports the step as blocked', () => {
    const collision = field([], [blocker('wall', 10, 0, 1, 20)]);
    const move = resolveMove(collision, { x: 9.6, z: 5 }, { x: 9.9, z: 5.3 }, RADIUS, [], []);
    expect(move.blocked).toBe(true);
    expect(move.position.x).toBeCloseTo(9.7, 5);
    expect(move.position.z).toBeCloseTo(5.3, 5);
  });

  it('takes a free step whole', () => {
    const move = resolveMove(field(), { x: 5, z: 5 }, { x: 5.4, z: 5.2 }, RADIUS, [], []);
    expect(move.blocked).toBe(false);
    expect(move.position.x).toBeCloseTo(5.4, 9);
    expect(move.position.z).toBeCloseTo(5.2, 9);
  });

  /**
   * The barracks turned to face its door south, as it stands on the square. Its door posts and
   * the side block stand proud of its front, so a body walking along the front clips them.
   */
  describe('along the barracks front', () => {
    const barracks = placement('barracks-1', 'building-barracks', 10, 10, 270);
    const sector = outdoorSector('Field', { x: 0, z: 0 }, { placements: [barracks] });
    const collision = bundledField([barracks]);
    const door = resolveDoor(sector, { id: 'main', placement: barracks.id, anchor: 'main', target: { sector: 'Barracks', door: 'exit' } }, BUNDLED)!;
    /** The model's +Z, along its front toward the door from its far side. */
    const along = modelToWorld({ x: 0, z: 0, yaw: barracks.yaw }, { x: 0, z: 1 });

    it('rounds a door post and reaches the door', () => {
      const path = walk(collision, modelToWorld(barracks, { x: 3, z: -2 }), along, 40);
      expect(path.some((point) => doorContains(door, point, 0))).toBe(true);
    });

    it('rounds the side block and passes the building, either way along it', () => {
      const there = walk(collision, modelToWorld(barracks, { x: 3.25, z: -2 }), along, 120).at(-1)!;
      expect(worldToModel(barracks, there).z).toBeGreaterThan(2.94 + RADIUS);
      const back = walk(collision, modelToWorld(barracks, { x: 3.25, z: 4 }), { x: -along.x, z: -along.z }, 120).at(-1)!;
      expect(worldToModel(barracks, back).z).toBeLessThan(-0.94 - RADIUS);
    });
  });

  it('glides round the convex end of a stair-side ledge', () => {
    const townhall = placement('townhall-1', 'building-townhall', 10, 10, 270);
    // On the porch, by the end of the ledge along the stair's +Z side.
    const start = modelToWorld(townhall, { x: 2.15, z: 1.62 });
    const end = walk(bundledField([townhall]), start, { x: -Math.SQRT1_2, z: Math.SQRT1_2 }, 20).at(-1)!;
    expect(distance(start, end)).toBeGreaterThan(0.2);
  });

  it('glides along a face at any yaw, not along a world axis', () => {
    const box = placement('box-1', 'box', 10, 10, 30);
    const normal = modelToWorld({ x: 0, z: 0, yaw: box.yaw }, { x: 0, z: 1 });
    const tangent = modelToWorld({ x: 0, z: 0, yaw: box.yaw }, { x: 1, z: 0 });
    const from = modelToWorld(box, { x: 0, z: 0.81 });
    const into = MOVE_SUBSTEP * Math.SQRT1_2;
    const to = { x: from.x + (tangent.x - normal.x) * into, z: from.z + (tangent.z - normal.z) * into };
    const moved = resolveMove(field([box]), from, to, RADIUS, [], []).position;
    const displacement = { x: moved.x - from.x, z: moved.z - from.z };
    expect(displacement.x * normal.x + displacement.z * normal.z).toBeCloseTo(0, 12);
    expect(displacement.x * tangent.x + displacement.z * tangent.z).toBeCloseTo(into, 12);
  });

  it('stops in the inside corner of two walls', () => {
    const collision = field([], [blocker('east', 10, 0, 1, 20), blocker('south', 0, 10, 10, 1)]);
    const from = { x: 9.7, z: 9.7 };
    expect(resolveMove(collision, from, { x: 9.735, z: 9.735 }, RADIUS, [], []).position).toEqual(from);
  });

  it('stops where two faces close in at an angle, though what is left of the step would fit', () => {
    // The blocker's face is 2.5 cm west of the body and the box's 1.5 cm north-east, meeting in a 60 degree wedge.
    const collision = field([placement('box-1', 'box', 10.4075, 9.29422, 330)], [blocker('wall', 8.675, 0, 1, 20)]);
    const from = { x: 10, z: 10 };
    expect(resolveMove(collision, from, { x: 9.97, z: 9.96 }, RADIUS, [], []).position).toEqual(from);
  });

  it('stops where two faces close in at different distances', () => {
    // The blocker's face is 3 cm west of the body; the box closes in from the north.
    const collision = field([placement('box-1', 'box', 9.6, 8.71, 120)], [blocker('wall', 8.67, 0, 1, 20)]);
    const from = { x: 10, z: 10 };
    expect(resolveMove(collision, from, { x: 9.965, z: 9.965 }, RADIUS, [], []).position).toEqual(from);
  });

  it.each<[string, number]>([
    ['the nearest point of the wall lies inside the box', 8.652],
    ['the nearest point of the wall lies on the face of the box', 10 - RADIUS / Math.cos(Math.PI / 6) - 1],
  ])('stops where a turned face stands out of a wall at an angle, where %s', (_label, wallZ) => {
    // The box's face is in contact 30 degrees off the wall's, and the wall's face is 4.8 cm or less north of the body.
    const collision = field([placement('box-1', 'box', 10.4, 9.30717967697245, 330)], [blocker('wall', 0, wallZ, 20, 1)]);
    const from = { x: 10, z: 10 };
    expect(resolveMove(collision, from, { x: 10, z: 9.951 }, RADIUS, [], []).position).toEqual(from);
  });

  it('does not creep along a face it meets head-on', () => {
    const box = placement('box-1', 'box', 10, 10, 30);
    const from = modelToWorld(box, { x: 0, z: 0.8 });
    // 0.06 degrees off head-on leaves a glide of 5.2e-5 m, about half the shortest that counts.
    const back = modelToWorld({ x: 0, z: 0, yaw: box.yaw + 0.06 }, { x: 0, z: -1 });
    const to = { x: from.x + back.x * MOVE_SUBSTEP, z: from.z + back.z * MOVE_SUBSTEP };
    expect(resolveMove(field([box]), from, to, RADIUS, [], []).position).toEqual(from);
  });

  const roundBody = { x: 10.1, z: 9, radius: 0.3 };
  it.each<[string, Body[], Body[]]>([
    ['an NPC', [roundBody], []],
    ['a drawn player', [], [roundBody]],
  ])('glides round %s', (_label, npcs, bodies) => {
    const end = walk(field(), { x: 10, z: 10 }, { x: 0, z: -1 }, 20, npcs, bodies).at(-1)!;
    // A step due north has no part along x to slide on, so without the glide the body stops at z 9.6.
    expect(end.x).toBeLessThan(9.9);
    expect(end.z).toBeLessThan(9.56);
  });

  it.each<[string, Body[], Body[]]>([
    ['an NPC', [{ x: 9.3896300614044, z: 10.398875043172934, radius: RADIUS }], []],
    ['a drawn player', [], [{ x: 9.3896300614044, z: 10.398875043172934, radius: RADIUS }]],
  ])('counts %s in what it glides along, and slides along an axis where the glide would lean toward it', (_label, npcs, bodies) => {
    const collision = field(
      [],
      [
        blocker('south', 9.879049205780028, 10.28341131210327, 0.40570998191833496, 0.4955604076385498),
        blocker('north', 9.995115184783934, 9.540071773529052, 0.29175200462341305, 0.06125025749206543),
      ],
    );
    const from = { x: 9.8422437235713, z: 9.96650743484497 };
    const to = { x: 9.827381459711123, z: 10.014247492584257 };
    // With nothing round in the way the step glides.
    expect(resolveMove(collision, from, to, RADIUS, [], []).position.z).not.toBe(from.z);
    expect(resolveMove(collision, from, to, RADIUS, npcs, bodies).position).toEqual({ x: to.x, z: from.z });
  });

  it.each<[string, Body[], Body[]]>([
    ['an NPC', [{ x: 10.46, z: 10.4, radius: RADIUS }], []],
    ['a drawn player', [], [{ x: 10.46, z: 10.4, radius: RADIUS }]],
  ])('glides off a joint in a wall where %s stands in the way along it, rather than stopping', (_label, npcs, bodies) => {
    // The full step stays clear of it, so only the glide along the wall's run meets it, and both axis slides are refused.
    const collision = field([], [blocker('west', 1, 9, 9, 1), blocker('east', 10, 9, 9, 1)]);
    const from = { x: 9.83, z: 10.3 };
    const moved = resolveMove(collision, from, { x: 9.87, z: 10.27 }, RADIUS, npcs, bodies).position;
    expect(distance(from, moved)).toBeGreaterThan(0.03);
  });

  it('glides along a face beside a drawn player it overlaps and steps away from', () => {
    const box = placement('box-1', 'box', 10, 10, 15);
    const from = modelToWorld(box, { x: 0.85, z: 0.81 });
    const peer = { x: from.x + 0.06, z: from.z + 0.21, radius: RADIUS };
    const to = { x: from.x + 0.02, z: from.z - 0.02 * Math.sqrt(3) };
    const moved = resolveMove(field([box]), from, to, RADIUS, [], [peer]).position;
    const tangent = modelToWorld({ x: 0, z: 0, yaw: box.yaw }, { x: 1, z: 0 });
    expect((moved.x - from.x) * tangent.x + (moved.z - from.z) * tangent.z).toBeGreaterThan(0.02);
  });

  describe('against an axis-aligned face', () => {
    it.each<[string, SpaceCollision, Point, Point]>([
      ['a blocker', field([], [blocker('wall', 10, 0, 1, 20)]), { x: 9.69, z: 5 }, { x: 9.72, z: 5.03 }],
      ['a sector edge', field(), { x: 19.69, z: 5 }, { x: 19.72, z: 5.03 }],
      ['an unturned model', field([placement('box-1', 'box', 10, 10)]), { x: 11.31, z: 10 }, { x: 11.28, z: 10.03 }],
    ])('keeps the blocked coordinate and takes the free one whole, against %s', (_label, collision, from, to) => {
      expect(resolveMove(collision, from, to, RADIUS, [], []).position).toEqual({ x: from.x, z: from.z + (to.z - from.z) });
    });

    /**
     * Each face runs west to east with a joint at `joint`, and the body slides north-east along it
     * from its south side. Pieces that should meet miss by a rounding error, as decimal metres do,
     * or by up to `EDGE_TOLERANCE`.
     */
    it.each<[string, SpaceCollision, Point, number]>([
      ['blockers', field([], [blocker('west', 1.03, 9, 8.87, 1), blocker('east', 9.9, 9, 10, 1)]), { x: 8.9, z: 10.3 }, 9.9],
      ['blockers a millimetre apart', field([], [blocker('west', 1, 9, 8.9990005, 1), blocker('east', 10, 9, 9, 1)]), { x: 9, z: 10.3 }, 10],
      ['unturned models', field([placement('box-1', 'box', 9, 10), placement('box-2', 'box', 11, 10)]), { x: 9, z: 10.8 }, 10],
      [
        'sectors',
        buildSpaceCollision({ id: 'outdoors', sectors: [outdoorSector('West', { x: 0, z: 0 }), outdoorSector('East', { x: 20, z: 0 })] }, TEST_REGISTRY),
        { x: 19, z: 0.3 },
        20,
      ],
    ])('keeps the blocked coordinate across the joint of two %s in a line', (_label, collision, from, joint) => {
      const path = walk(collision, from, { x: Math.cos(Math.PI / 6), z: -Math.sin(Math.PI / 6) }, 40);
      expect(path.map((point) => point.z)).toEqual(path.map(() => from.z));
      expect(path.at(-1)!.x).toBeGreaterThan(joint + 0.5);
    });

    it.each<[string, Point, Point]>([
      ['north', { x: 9, z: 8.7 }, { x: Math.cos(Math.PI / 6), z: Math.sin(Math.PI / 6) }],
      ['south', { x: 9, z: 10.3 }, { x: Math.cos(Math.PI / 6), z: -Math.sin(Math.PI / 6) }],
      ['west', { x: 8.7, z: 9 }, { x: Math.sin(Math.PI / 6), z: Math.cos(Math.PI / 6) }],
      ['east', { x: 10.3, z: 9 }, { x: -Math.sin(Math.PI / 6), z: Math.cos(Math.PI / 6) }],
    ])('keeps the blocked coordinate across the joint of two blockers from the %s', (side, from, direction) => {
      // The pieces meet at 10 along the wall: east to west for a body north or south of it, north to south for one west or east.
      const across = side === 'north' || side === 'south';
      const pieces = across ? [blocker('west', 1, 9, 9, 1), blocker('east', 10, 9, 9, 1)] : [blocker('north', 9, 1, 1, 9), blocker('south', 9, 10, 1, 9)];
      const path = walk(field([], pieces), from, direction, 40);
      const blockedOf = (point: Point): number => (across ? point.z : point.x);
      expect(path.map(blockedOf)).toEqual(path.map(() => blockedOf(from)));
      expect(across ? path.at(-1)!.x : path.at(-1)!.z).toBeGreaterThan(10.5);
    });

    it("keeps the blocked coordinate where a blocker's face lies on the sector's edge, onto the blocker from past its end", () => {
      // The blocker stands outside the sector, as a room's wall does, and its face continues the edge's.
      const from = { x: 7, z: 0.3 };
      const path = walk(field([], [blocker('wall', 4, -1, 2, 1)]), from, { x: -Math.cos(Math.PI / 6), z: -Math.sin(Math.PI / 6) }, 40);
      expect(path.map((point) => point.z)).toEqual(path.map(() => from.z));
      expect(path.at(-1)!.x).toBeLessThan(5.5);
    });

    it('takes the end of a piece as a corner where the next piece is set back from it', () => {
      // The east piece's face is 2 cm behind the west piece's, so the two are no run, and the body leaves the west piece's line past its end.
      const collision = field([], [blocker('west', 1, 8, 9, 1), blocker('east', 10, 7, 9, 1.98)]);
      const path = walk(collision, { x: 9.8, z: 9.3 }, { x: Math.cos(Math.PI / 6), z: -Math.sin(Math.PI / 6) }, 12);
      // Joined as one run, the two faces would hold the body at z 9.3.
      expect(path.at(-1)!.z).toBeCloseTo(9.29806, 5);
      expect(path.at(-1)!.x).toBeGreaterThan(10.2);
    });

    it('keeps the blocked coordinate beside a piece up to a gap the body cannot enter, and takes the far side as a corner', () => {
      // The gap is 5 cm, wider than `EDGE_TOLERANCE`: the far piece lies near enough to be gathered before it refuses the step.
      const collision = field([], [blocker('west', 1, 9, 9, 1), blocker('east', 10.05, 9, 9, 1)]);
      const angle = (2 * Math.PI) / 180;
      for (let offset = 0; offset < 0.05; offset += 0.01) {
        const path = walk(collision, { x: 9.5 + offset, z: 10.3 }, { x: Math.cos(angle), z: -Math.sin(angle) }, 30);
        const beside = path.filter((point) => point.x < 9.97);
        expect(beside.map((point) => point.z)).toEqual(beside.map(() => 10.3));
        expect(Math.max(...path.map((point) => point.z))).toBeGreaterThan(10.303);
        expect(path.at(-1)!.x).toBeGreaterThan(10.9);
      }
    });

    it('keeps the blocked coordinate across the joint of two sectors stacked north to south', () => {
      const collision = buildSpaceCollision(
        { id: 'outdoors', sectors: [outdoorSector('North', { x: 0, z: 0 }), outdoorSector('South', { x: 0, z: 20 })] },
        TEST_REGISTRY,
      );
      const from = { x: 0.3, z: 21 };
      const path = walk(collision, from, { x: -Math.sin(Math.PI / 6), z: -Math.cos(Math.PI / 6) }, 40);
      expect(path.map((point) => point.x)).toEqual(path.map(() => from.x));
      expect(path.at(-1)!.z).toBeLessThan(19.5);
    });

    it('keeps the blocked coordinate along a wall of pieces shorter than the body', () => {
      // The piece the step reaches joins the piece beside the body only through the pieces between them, listed from the end the body starts at.
      const pieces = Array.from({ length: 20 }, (_, index) => blocker(`piece-${index}`, 10.9 - index / 10, 9, 0.1, 1));
      const from = { x: 10.8, z: 10.3 };
      const path = walk(field([], pieces), from, { x: -Math.cos(Math.PI / 6), z: -Math.sin(Math.PI / 6) }, 30);
      expect(path.map((point) => point.z)).toEqual(path.map(() => from.z));
      expect(path.at(-1)!.x).toBeLessThan(9.6);
    });

    it('keeps the blocked coordinate across a joint it slides along almost parallel', () => {
      // Near the joint the step touches only the piece ahead, while the piece behind still stands beside the body.
      const collision = field([], [blocker('west', 1, 9, 9, 1), blocker('east', 10, 9, 9, 1)]);
      for (const degrees of [0.5, 1, 2]) {
        const angle = (degrees * Math.PI) / 180;
        for (let offset = 0; offset < 0.05; offset += 0.005) {
          const from = { x: 9.5 + offset, z: 10.3 };
          const path = walk(collision, from, { x: Math.cos(angle), z: -Math.sin(angle) }, 30);
          expect(path.map((point) => point.z)).toEqual(path.map(() => from.z));
          expect(path.at(-1)!.x).toBeGreaterThan(10.5);
        }
      }
    });

    it('keeps the blocked coordinate against a model turned by a quarter', () => {
      const from = { x: 10.81, z: 10 };
      const moved = resolveMove(field([placement('box-1', 'box', 10, 10, 270)]), from, { x: 10.78, z: 10.03 }, RADIUS, [], []).position;
      expect(moved.x).toBe(from.x);
      expect(Math.abs(moved.z - 10.03)).toBeLessThan(1e-12);
    });
  });

  it.each([
    [90, 0],
    [37, 0],
    [37, 480],
  ])('keeps a body flush across the joint of two models in a line turned by %d degrees, %d m from the origin', (yaw, origin) => {
    const turn = { x: 10, z: 10, yaw };
    const pieces = [-1, 1].map((x, index) => placement(`box-${index}`, 'box', modelToWorld(turn, { x, z: 0 }).x, modelToWorld(turn, { x, z: 0 }).z, yaw));
    const collision = buildSpaceCollision(
      { id: 'outdoors', sectors: [outdoorSector('Field', { x: origin, z: origin }, { placements: pieces })] },
      TEST_REGISTRY,
    );
    // In the model's space the pieces' faces run along z 0.5, with the joint at x 0.
    const inSpace = { ...turn, x: origin + turn.x, z: origin + turn.z };
    const path = walk(
      collision,
      modelToWorld(inSpace, { x: -0.6, z: 0.8 }),
      modelToWorld({ x: 0, z: 0, yaw }, { x: Math.cos(Math.PI / 90), z: -Math.sin(Math.PI / 90) }),
      24,
    );
    for (const point of path) expect(Math.abs(worldToModel(inSpace, point).z - 0.8)).toBeLessThan(1e-12);
    expect(worldToModel(inSpace, path.at(-1)!).x).toBeGreaterThan(0.5);
  });

  it('glides along a turned face that stands out of a wall rather than stopping', () => {
    // The box is buried in the wall but for a sliver of its turned face, whose nearest point lies inside the wall.
    const collision = field([placement('box-1', 'box', 9.913175911166535, 9.497596123493896, 10)], [blocker('wall', 0, 9, 20, 1)]);
    const from = { x: 10, z: 10.3 };
    const moved = resolveMove(collision, from, { x: 9.965, z: 10.265 }, RADIUS, [], []).position;
    expect(distance(from, moved)).toBeGreaterThan(0.03);
  });

  it('glides round a corner near a wall, though the wall is nearer', () => {
    // The blocker's face is 1.2 cm west of the body; a corner of the box closes in from the north.
    const collision = field([placement('box-1', 'box', 9.79, 8.6, 120)], [blocker('wall', 8.688, 0, 1, 20)]);
    const from = { x: 10, z: 10 };
    const moved = resolveMove(collision, from, { x: 9.983, z: 9.953 }, RADIUS, [], []).position;
    expect(distance(from, moved)).toBeGreaterThan(0.02);
  });

  it('glides round the corner of a turned face beside a wall, though the corner lies inside the wall', () => {
    // Taking the corner as a joint in the wall's face would run the body into the box's face, which stands out of the wall.
    const collision = field([placement('box-1', 'box', 8.94, 9.57, 4)], [blocker('wall', 0, 9, 20, 1)]);
    const from = { x: 10, z: 10.301 };
    const moved = resolveMove(collision, from, { x: 9.951, z: 10.2993 }, RADIUS, [], []).position;
    expect(distance(from, moved)).toBeGreaterThan(0.045);
  });

  it('falls back to an axis slide where the glide would turn back against the step', () => {
    const collision = bundledField([placement('townhall-1', 'building-townhall', 10, 10, 270)]);
    const from = { x: 9.66, z: 12.7 };
    const step = { x: 0.0315138, z: 0.0055567 };
    const to = { x: from.x + step.x, z: from.z + step.z };
    expect(isLegalMove(collision, from, to, RADIUS, [])).toBe(false);
    const move = resolveMove(collision, from, to, RADIUS, [], []);
    expect(move.blocked).toBe(true);
    expect(move.position).toEqual({ x: from.x, z: from.z + step.z });
  });

  it('falls back to an axis slide where the glide would run into something else', () => {
    // The glide along the box's face would bring the body against the blocker's corner; the slide west stays clear of it.
    const box = placement('box-1', 'box', 10, 10, 60);
    const collision = field([box], [blocker('block', 10.73, 10.1, 1.32, 0.61)]);
    const from = modelToWorld(box, { x: -0.52, z: 0.82 });
    const step = { x: 0.04 * Math.cos((245 * Math.PI) / 180), z: 0.04 * Math.sin((245 * Math.PI) / 180) };
    const move = resolveMove(collision, from, { x: from.x + step.x, z: from.z + step.z }, RADIUS, [], []);
    expect(move.position).toEqual({ x: from.x + step.x, z: from.z });
  });

  it('glides along one face without being pulled back toward another it steps away from, whichever is listed first', () => {
    const box = placement('box-1', 'box', 10, 10, 30);
    const other = placement('box-2', 'box', 9.43, 10.62, 45);
    const from = modelToWorld(box, { x: 0.26, z: 0.801 });
    const to = { x: from.x + 0.04 * Math.cos((265 * Math.PI) / 180), z: from.z + 0.04 * Math.sin((265 * Math.PI) / 180) };
    const tangent = modelToWorld({ x: 0, z: 0, yaw: box.yaw }, { x: 1, z: 0 });
    for (const placements of [
      [box, other],
      [other, box],
    ]) {
      const moved = resolveMove(field(placements), from, to, RADIUS, [], []).position;
      expect((moved.x - from.x) * tangent.x + (moved.z - from.z) * tangent.z).toBeGreaterThan(0.015);
    }
  });

  /**
   * Walks over the committed world as the predictor takes them, each call one `MOVE_SUBSTEP` step, from
   * within half a metre of something solid so most of them meet it. A result the move rule
   * refused from where the call began would be corrected by the server.
   */
  it('takes every step legal, no longer and never back, and moves wherever a full or axis step could', () => {
    const spaces = [...buildWorld(loadSectorFixtures(), BUNDLED).spaces.values()].map((space) => ({
      space,
      collision: buildSpaceCollision(space, BUNDLED),
      npcs: npcBodies(space),
    }));
    const random = seededSequence(hashString('the slide'));
    for (let walkIndex = 0; walkIndex < 200; walkIndex += 1) {
      const { space, collision, npcs } = spaces[Math.floor(random() * spaces.length)]!;
      const sector = sectorRect(space.sectors[Math.floor(random() * space.sectors.length)]!);
      let position: Point;
      do position = { x: sector.x + random() * sector.width, z: sector.z + random() * sector.depth };
      while (!canStand(collision, position, npcs) || isClear(collision, position, RADIUS + 0.5));
      const angle = random() * 2 * Math.PI;
      const direction = { x: Math.cos(angle), z: Math.sin(angle) };
      const bodies = random() < 1 / 3 ? [{ x: position.x + random() * 2 - 1, z: position.z + random() * 2 - 1, radius: RADIUS }] : [];
      const legal = (from: Point, to: Point): boolean =>
        isLegalMove(collision, from, to, RADIUS, npcs) && !bodies.some((body) => bodyBlocks(from, to, RADIUS, body));
      const step = { x: direction.x * MOVE_SUBSTEP, z: direction.z * MOVE_SUBSTEP };
      for (let call = 0; call < 20; call += 1) {
        const to = { x: position.x + step.x, z: position.z + step.z };
        const moved = resolveMove(collision, position, to, RADIUS, npcs, bodies).position;
        const label = `walk ${walkIndex}, call ${call}, from (${position.x}, ${position.z})`;
        if (moved.x === position.x && moved.z === position.z) {
          const fullOrAxis = [to, { x: to.x, z: position.z }, { x: position.x, z: to.z }];
          expect(
            fullOrAxis.some((next) => legal(position, next)),
            label,
          ).toBe(false);
          continue;
        }
        expect(legal(position, moved), label).toBe(true);
        expect(distance(position, moved), label).toBeLessThanOrEqual(MOVE_SUBSTEP + 1e-12);
        expect((moved.x - position.x) * step.x + (moved.z - position.z) * step.z, label).toBeGreaterThan(0);
        position = moved;
      }
    }
  });
});

describe('gaps narrower than the body', () => {
  /** Two walls on the line x 9..10 leaving an opening of `gap` metres centred on z = 10. */
  function gapped(gap: number): SpaceCollision {
    return field([], [blocker('north', 9, 0, 1, 10 - gap / 2), blocker('south', 9, 10 + gap / 2, 1, 10 - gap / 2)]);
  }

  it('refuses a long move whose ends are clear but whose path squeezes through', () => {
    expect(isLegalMove(gapped(0.5), { x: 8, z: 10 }, { x: 11, z: 10 }, RADIUS, [])).toBe(false);
  });

  it('refuses the short move that would start the squeeze', () => {
    const collision = gapped(0.5);
    expect(isLegalMove(collision, { x: 8.75, z: 10 }, { x: 8.8, z: 10 }, RADIUS, [])).toBe(true);
    expect(isLegalMove(collision, { x: 8.8, z: 10 }, { x: 8.85, z: 10 }, RADIUS, [])).toBe(false);
  });

  it('accepts the same long move through an opening the body fits', () => {
    expect(isLegalMove(gapped(0.7), { x: 8, z: 10 }, { x: 11, z: 10 }, RADIUS, [])).toBe(true);
  });
});

describe('bodies', () => {
  const body = { x: 0, z: 0, radius: RADIUS };

  it('block an approach at contact', () => {
    expect(bodyBlocks({ x: 1, z: 0 }, { x: 0.59, z: 0 }, RADIUS, body)).toBe(true);
    expect(bodyBlocks({ x: 1, z: 0 }, { x: 0.6, z: 0 }, RADIUS, body)).toBe(false);
  });

  it('let an overlapping pair separate but not close in, whichever of the two moves', () => {
    for (const side of [1, -1]) {
      const from = { x: 0.4 * side, z: 0 };
      expect(bodyBlocks(from, { x: 0.35 * side, z: 0 }, RADIUS, body)).toBe(true);
      expect(bodyBlocks(from, { x: 0.45 * side, z: 0 }, RADIUS, body)).toBe(false);
    }
  });

  it('stop a step toward a drawn player and free one away from an overlap', () => {
    const collision = field();
    const peer = { x: 10, z: 10, radius: RADIUS };
    const toward = resolveMove(collision, { x: 9, z: 10 }, { x: 10, z: 10 }, RADIUS, [], [peer]);
    expect(toward.blocked).toBe(true);
    expect(toward.position.x).toBeCloseTo(9.4, 1);
    const away = resolveMove(collision, { x: 9.8, z: 10 }, { x: 9, z: 10 }, RADIUS, [], [peer]);
    expect(away.blocked).toBe(false);
    expect(away.position.x).toBeCloseTo(9, 9);
    expect(resolveMove(collision, { x: 9.8, z: 10 }, { x: 10, z: 10 }, RADIUS, [], [peer]).position).toEqual({ x: 9.8, z: 10 });
  });

  it('do not enter the legality of a move, where NPCs do', () => {
    const collision = field();
    const npc = { x: 10, z: 10, radius: SOMNIO_CONSTANTS.npcRadius };
    expect(isLegalMove(collision, { x: 9, z: 10 }, { x: 9.4, z: 10 }, RADIUS, [npc])).toBe(true);
    expect(isLegalMove(collision, { x: 9, z: 10 }, { x: 9.5, z: 10 }, RADIUS, [npc])).toBe(false);
    expect(isLegalMove(collision, { x: 9, z: 10 }, { x: 11, z: 10 }, RADIUS, [npc])).toBe(false);
    expect(isLegalMove(collision, { x: 9, z: 10 }, { x: 11, z: 10 }, RADIUS, [])).toBe(true);
    expect(resolveMove(collision, { x: 9, z: 10 }, { x: 10, z: 10 }, RADIUS, [npc], []).blocked).toBe(true);
  });

  it('of NPCs stand where their sector puts them in the space', () => {
    const guide = { id: 'guide', name: 'Guide', characterModelId: 'hero', x: 3, z: 4, facing: 0, dialogScript: '' };
    const sectors = [outdoorSector('West', { x: 0, z: 0 }), outdoorSector('East', { x: 20, z: -5 }, { npcs: [guide] })];
    expect(npcBodies({ id: 'outdoors', sectors })).toEqual([{ x: 23, z: -1, radius: SOMNIO_CONSTANTS.npcRadius }]);
  });
});

/**
 * The hall stands at (10, 10) unrotated, so a model-space point is the world point less (10, 10):
 * the porch runs x 1.42..2.42, the landing and the treads continue east of it on z 0.04..1.76.
 */
describe('stairs and porch', () => {
  const hall = placement('hall-1', 'hall', 10, 10);
  const collision = field([hall]);
  const at = (x: number, z: number): Point => modelToWorld(hall, { x, z });

  it('derives ledges whose ends are the edges of the adjoining surfaces', () => {
    const rounded = (segments: readonly Segment[]): number[][] =>
      segments.map((segment) => [segment.a.x, segment.a.z, segment.b.x, segment.b.z].map((value) => Math.round(value * 1e9) / 1e9 + 0));
    expect(rounded(walkSurfaceLedges(objectModel(TEST_REGISTRY, 'hall')!.walkSurfaces))).toEqual([
      // The porch: its whole north, south, and west edges, and its east edge either side of the landing.
      [1.42, -0.27, 2.42, -0.27],
      [1.42, 3.35, 2.42, 3.35],
      [1.42, -0.27, 1.42, 3.35],
      [2.42, -0.27, 2.42, 0.04],
      [2.42, 1.76, 2.42, 3.35],
      // The landing and the two upper treads: their sides. The lowest tread is within the step height.
      [2.42, 0.04, 2.82, 0.04],
      [2.42, 1.76, 2.82, 1.76],
      [2.82, 0.04, 3.17, 0.04],
      [2.82, 1.76, 3.17, 1.76],
      [3.17, 0.04, 3.5, 0.04],
      [3.17, 1.76, 3.5, 1.76],
    ]);
  });

  it('keeps a body a radius away from the porch edge, on the porch and on the ground', () => {
    expect(isClear(collision, at(2.13, 2.5), RADIUS)).toBe(false);
    expect(isClear(collision, at(2.12, 2.5), RADIUS)).toBe(true);
    expect(groundHeightAt(collision, at(2.12, 2.5))).toBe(1.03);
    expect(isClear(collision, at(2.71, 2.5), RADIUS)).toBe(false);
    expect(isClear(collision, at(2.72, 2.5), RADIUS)).toBe(true);
    expect(groundHeightAt(collision, at(2.72, 2.5))).toBe(0);
  });

  it('climbs the treads from the front, one step height at a time', () => {
    const heights = new Set<number>();
    let position = at(4.5, 0.9);
    for (let step = 0; step < 55; step += 1) {
      const move = resolveMove(collision, position, { x: position.x - 0.05, z: position.z }, RADIUS, [], []);
      expect(move.blocked).toBe(false);
      position = move.position;
      heights.add(groundHeightAt(collision, position));
    }
    expect([...heights]).toEqual([0, 0.26, 0.52, 0.77, 1.03]);
    // The building's front wall stops the climb a radius out, on the porch.
    const stopped = resolveMove(collision, position, at(1.5, 0.9), RADIUS, [], []);
    expect(stopped.blocked).toBe(true);
    expect(worldToModel(hall, stopped.position).x).toBeGreaterThanOrEqual(1.42 + RADIUS - 1e-6);
  });

  it('blocks the upper treads from the side and lets the lowest one be stepped onto', () => {
    const upper = resolveMove(collision, at(3.33, -0.5), at(3.33, 0.9), RADIUS, [], []);
    expect(upper.blocked).toBe(true);
    expect(worldToModel(hall, upper.position).z).toBeLessThanOrEqual(0.04 - RADIUS + 1e-6);
    expect(groundHeightAt(collision, upper.position)).toBe(0);

    const lowest = resolveMove(collision, at(3.83, -0.5), at(3.83, 0.9), RADIUS, [], []);
    expect(lowest.blocked).toBe(false);
    expect(groundHeightAt(collision, lowest.position)).toBe(0.26);
  });

  it('slides a diagonal up the stair edge and round the corner onto the porch without wedging', () => {
    let position = at(3.3, 1.2);
    const stride = (2 / 60) * Math.SQRT1_2;
    for (let frame = 0; frame < 240; frame += 1) {
      position = resolveMove(collision, position, { x: position.x - stride, z: position.z + stride }, RADIUS, [], []).position;
    }
    // Held to the end, the diagonal rests in the porch's far corner: a radius off the wall and off the south ledge.
    const rest = worldToModel(hall, position);
    expect(rest.x).toBeCloseTo(1.42 + RADIUS, 1);
    expect(rest.z).toBeCloseTo(3.35 - RADIUS, 1);
    expect(groundHeightAt(collision, position)).toBe(1.03);
  });

  it('slides along the side of the stair across the joints of its treads', () => {
    const from = at(3.45, 2.061);
    const path = walk(collision, from, { x: -Math.cos(Math.PI / 6), z: -Math.sin(Math.PI / 6) }, 30);
    expect(path.map((point) => point.z)).toEqual(path.map(() => from.z));
    // Past the joints at 3.17 and 2.82 to the porch's edge.
    expect(worldToModel(hall, path.at(-1)!).x).toBeLessThan(2.8);
  });

  it('refuses a move that rises more than the step height even where no ledge is touched', () => {
    // A body this thin fits between two path samples, so only the height rule can refuse it.
    const thin = 0.005;
    expect(isClear(collision, at(2.6, 2.5), thin)).toBe(true);
    expect(isClear(collision, at(2.3, 2.5), thin)).toBe(true);
    expect(isLegalMove(collision, at(2.6, 2.5), at(2.3, 2.5), thin, [])).toBe(false);
  });

  it('stands the same way at a quarter turn', () => {
    const turned = placement('hall-1', 'hall', 10, 10, 270);
    const rotated = field([turned]);
    // At yaw 270 the model's +X (the door side) points south and its +Z points west.
    expect(groundHeightAt(rotated, { x: 9.1, z: 12 })).toBe(1.03);
    expect(groundHeightAt(rotated, { x: 10.9, z: 12 })).toBe(0);
    expect(isClear(rotated, modelToWorld(turned, { x: 2.13, z: 2.5 }), RADIUS)).toBe(false);
  });

  it('reports an elevation on a model with walk surfaces, and only there', () => {
    const lifted = field([placement('hall-1', 'hall', 10, 10, 0, 0.5), placement('rug-1', 'rug', 3, 3, 0, 0.5)]);
    expect(lifted.issues).toEqual([{ sector: 'Field', record: 'placement', id: 'hall-1', message: expect.stringContaining('elevation 0.5 is ignored') }]);
    expect(groundHeightAt(lifted, at(2, 0.9))).toBe(1.03);
  });
});

describe('walk surfaces of two placements', () => {
  const dais = placement('dais-1', 'dais', 5, 5);
  const stage = placement('stage-1', 'stage', 6, 5.5, 45);

  it('are reported where they overlap, and the higher one wins whatever the record order', () => {
    for (const placements of [
      [dais, stage],
      [stage, dais],
    ]) {
      const collision = field(placements);
      expect(collision.issues.map((issue) => issue.id).sort()).toEqual(['dais-1', 'stage-1']);
      expect(collision.issues.every((issue) => issue.message.includes('walk surfaces overlap'))).toBe(true);
      expect(groundHeightAt(collision, { x: 5.6, z: 5.4 })).toBe(0.25);
      expect(groundHeightAt(collision, { x: 4.2, z: 4.2 })).toBe(0.2);
    }
  });

  it('are not reported when they only touch', () => {
    expect(field([dais, placement('dais-2', 'dais', 7, 5)]).issues).toEqual([]);
  });

  it('report each placement once, however many it overlaps, naming the first it overlaps', () => {
    const stacked = ['dais-0', 'dais-1', 'dais-2'].map((id) => placement(id, 'dais', 5, 5));
    const overlap = (id: string, first: string) => ({
      sector: 'Field',
      record: 'placement',
      id,
      message: `walk surfaces overlap those of "${first}" in Field`,
    });
    expect(field(stacked).issues).toEqual([overlap('dais-0', 'dais-1'), overlap('dais-1', 'dais-0'), overlap('dais-2', 'dais-0')]);
  });
});
