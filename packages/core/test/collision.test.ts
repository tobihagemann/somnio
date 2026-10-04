import type { Blocker, Placement } from '@somnio/protocol';
import { describe, expect, it } from 'vitest';
import { bodyBlocks, buildSpaceCollision, groundHeightAt, isClear, isLegalMove, npcBodies, resolveMove, walkSurfaceLedges } from '../src/collision.ts';
import type { SpaceCollision } from '../src/collision.ts';
import { SOMNIO_CONSTANTS } from '../src/constants.ts';
import { modelToWorld, worldToModel } from '../src/geometry.ts';
import type { Point, Segment } from '../src/geometry.ts';
import { objectModel } from '../src/modelRegistry.ts';
import { TEST_REGISTRY, outdoorSector } from './support/worldFixture.ts';

const RADIUS = SOMNIO_CONSTANTS.playerRadius;

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
});
