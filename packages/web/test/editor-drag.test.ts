import { describe, expect, it } from 'vitest';
import { SOMNIO_CONSTANTS, angularDistance, headingFromCardinal } from '@somnio/core';
import type { Point, Sector, SectorNPC } from '@somnio/core';
import { screenPoint } from '@/editor/canvasController';
import { EditorDocument } from '@/editor/document';
import {
  FACING_CLEARANCE_PT,
  TAP_SIZE,
  facingHandlePoint,
  gridDelta,
  headingFromDrag,
  hitHandle,
  metresPerViewportPoint,
  placementBounds,
  projectedCorners,
  rectIntersectsConvexQuad,
  resizedBounds,
  rubberBandBounds,
} from '@/editor/drag/geometry';
import type { DragContext } from '@/editor/drag/geometry';
import { applyBounds, applyFacing, applyMove, marqueeSelections, origins, placeRecord, turnable } from '@/editor/drag/mutations';
import type { PlacementDefaults } from '@/editor/drag/mutations';
import { beginSession, endSession, preview } from '@/editor/drag/session';
import type { DragSession } from '@/editor/drag/session';
import type { ScreenPoint } from '@/editor/picking';
import { footprintCorners, selectionFootprint } from '@/editor/selection';
import type { EditorSelection } from '@/editor/selection';
import { dragContext, emptySector } from './helpers/editorFixture';

/**
 * The drag layer — session classification, delta quantization, resize clamping, placement
 * seeds, handle hit-testing, facing rotation, marquee SAT, the commit guards that keep no-op
 * gestures off the undo stack, and the agreement between a live preview and what the same
 * gesture commits.
 */

const DEFAULTS: PlacementDefaults = { modelId: 'box', floorMaterialId: 'cobble', characterModelId: 'hero', monsterKind: 'gespenst' };

/** The press/drag location a user aiming at a sector-relative ground point would produce. */
function viewportPoint(point: Point, ctx: DragContext): ScreenPoint {
  return screenPoint(ctx, point);
}

function npc(at: Point, facing = headingFromCardinal('south')): SectorNPC {
  return { id: 'libus', name: 'Libus', characterModelId: 'hero', ...at, facing, dialogScript: '' };
}

function blocker(id: string, x: number, z: number, width = 1, depth = 1) {
  return { id, x, z, width, depth };
}

function box(id: string, x: number, z: number, yaw = 0) {
  return { id, modelId: 'box', x, z, yaw, elevation: 0 };
}

/** Document seeded with a body, for the `endSession` orchestration tests. */
function documentWith(body: Sector): EditorDocument {
  const document = new EditorDocument();
  expect(document.commit('Seed', structuredClone(body))).toEqual({ accepted: true });
  return document;
}

describe('move', () => {
  it('quantizes a drag delta to the grid step, preserving relative offsets', () => {
    const ctx = dragContext(0.5);
    expect(gridDelta(viewportPoint({ x: 5, z: 5 }, ctx), viewportPoint({ x: 6.3, z: 3.2 }, ctx), ctx)).toEqual({ dx: 1.5, dz: -2 });
  });

  it('keeps a free-snap drag delta to the millimetre', () => {
    const ctx = dragContext(0);
    expect(gridDelta(viewportPoint({ x: 5, z: 5 }, ctx), viewportPoint({ x: 5.123, z: 4.877 }, ctx), ctx)).toEqual({ dx: 0.123, dz: -0.123 });
  });

  it('shifts every snapshotted position by the same delta in a group move, leaving a door where its placement is', () => {
    const body = emptySector({
      placements: [{ id: 'door-1', modelId: 'door', x: 2, z: 2, yaw: 0, elevation: 0 }],
      doors: [{ id: 'exit', placement: 'door-1', anchor: 'main', target: { sector: 'Other', door: 'in' } }],
      npcs: [npc({ x: 10, z: 10 })],
      spawn: { x: 4, z: 4, facing: 0 },
    });
    const originals = origins(
      [
        { kind: 'placement', id: 'door-1' },
        { kind: 'door', id: 'exit' },
        { kind: 'npc', id: 'libus' },
        { kind: 'spawn', id: 'spawn' },
      ],
      body,
    );
    expect(originals.map((entry) => entry.selection.kind)).toEqual(['placement', 'npc', 'spawn']);
    applyMove(originals, 1.5, -0.5, body);
    expect(body.placements[0]).toMatchObject({ x: 3.5, z: 1.5 });
    expect(body.npcs[0]).toMatchObject({ x: 11.5, z: 9.5 });
    expect(body.spawn).toEqual({ x: 5.5, z: 3.5, facing: 0 });
  });

  it('writes a moved position as a short decimal', () => {
    const body = emptySector({ blockers: [blocker('wall', 5.12, 30.72)] });
    applyMove(origins([{ kind: 'blocker', id: 'wall' }], body), 0.1, 0.2, body);
    expect(body.blockers[0]).toMatchObject({ x: 5.22, z: 30.92 });
  });
});

describe('resize', () => {
  const rect = { x: 2, z: 2, width: 3, depth: 3 };

  it.each([
    ['grows in place from the bottom-right handle', 'bottomRight', 1, 2, { x: 2, z: 2, width: 4, depth: 5 }],
    ['shifts the origin and shrinks from the top-left handle', 'topLeft', 1, 1, { x: 3, z: 3, width: 2, depth: 2 }],
    ['moves only the north edge from the top handle', 'top', 1, 1, { x: 2, z: 3, width: 3, depth: 2 }],
    ['moves only the south edge from the bottom handle', 'bottom', 1, -1, { x: 2, z: 2, width: 3, depth: 2 }],
    ['moves only the west edge from the left handle', 'left', 1, 1, { x: 3, z: 2, width: 2, depth: 3 }],
    ['moves only the east edge from the right handle', 'right', 1, 1, { x: 2, z: 2, width: 4, depth: 3 }],
    ['grows north and east from the top-right handle', 'topRight', 1, -1, { x: 2, z: 1, width: 4, depth: 4 }],
    ['grows west and south from the bottom-left handle', 'bottomLeft', -1, 2, { x: 1, z: 2, width: 4, depth: 5 }],
    ['stops one minimum extent short of the opposite edge', 'right', -50, 0, { x: 2, z: 2, width: 0.5, depth: 3 }],
    ['keeps the opposite edge fixed when the moved one is pushed past it', 'left', 50, 0, { x: 4.5, z: 2, width: 0.5, depth: 3 }],
    ['stops the south edge one minimum extent short of the north one', 'bottom', 0, -50, { x: 2, z: 2, width: 3, depth: 0.5 }],
    ['keeps the south edge fixed when the north one is pushed past it', 'top', 0, 50, { x: 2, z: 4.5, width: 3, depth: 0.5 }],
  ] as const)('%s', (_name, handle, dx, dz, expected) => {
    expect(resizedBounds(rect, handle, dx, dz, 0.5)).toEqual(expected);
  });

  it('writes a handle resize to the monster spawn area', () => {
    const body = emptySector({ monsterSpawns: [{ id: 'spawn-1', kind: 'gespenst', x: 1, z: 1, width: 2, depth: 2, maxAlive: 3 }] });
    applyBounds({ kind: 'monsterSpawn', id: 'spawn-1' }, { x: 0.5, z: 0.5, width: 4, depth: 3 }, body);
    expect(body.monsterSpawns[0]).toEqual({ id: 'spawn-1', kind: 'gespenst', x: 0.5, z: 0.5, width: 4, depth: 3, maxAlive: 3 });
  });
});

describe('placement', () => {
  it('drops the tap size on a tap', () => {
    const ctx = dragContext(0.5);
    const press = viewportPoint({ x: 4.1, z: 3.1 }, ctx);
    expect(placementBounds('blocker', { x: 4, z: 3 }, press, press, ctx)).toEqual({ x: 4, z: 3, ...TAP_SIZE });
  });

  it('rubber-bands the quantized rect on a drag', () => {
    const ctx = dragContext(0.5);
    const bounds = placementBounds('blocker', { x: 4, z: 3 }, viewportPoint({ x: 4, z: 3 }, ctx), viewportPoint({ x: 7.1, z: 5.4 }, ctx), ctx);
    expect(bounds).toEqual({ x: 4, z: 3, width: 3, depth: 2.5 });
  });

  it('places a point record at the anchor however far the gesture travels', () => {
    const ctx = dragContext(0.5);
    const bounds = placementBounds('placement', { x: 4, z: 3 }, viewportPoint({ x: 4, z: 3 }, ctx), viewportPoint({ x: 9, z: 9 }, ctx), ctx);
    expect(bounds).toMatchObject({ x: 4, z: 3 });
  });

  it('normalizes a backwards rubber band with one snap step minimum', () => {
    expect(rubberBandBounds({ x: 4, z: 3 }, { x: 3, z: 3 }, 0.5)).toEqual({ x: 3, z: 3, width: 1, depth: 0.5 });
  });

  it.each([
    ['placement', { kind: 'placement', id: 'box-2' }],
    ['blocker', { kind: 'blocker', id: 'blocker-1' }],
    ['npc', { kind: 'npc', id: 'npc-1' }],
    ['monsterSpawn', { kind: 'monsterSpawn', id: 'spawn-1' }],
    ['floorPatch', { kind: 'floorPatch', id: 'patch-1' }],
    ['spawn', { kind: 'spawn', id: 'spawn' }],
  ] as const)('direct %s placement appends the default record under the next free id and selects it', (tool, expected) => {
    const body = emptySector({ placements: [box('box-1', 15, 15)] });
    expect(placeRecord(tool, { x: 3, z: 4, ...TAP_SIZE }, body, DEFAULTS)).toEqual(expected);
    // The placed body is one the sector codec accepts as it stands.
    expect(new EditorDocument().commit('Place', body)).toEqual({ accepted: true });
  });

  it('seeds each record from the defaults', () => {
    const body = emptySector();
    for (const tool of ['placement', 'blocker', 'npc', 'monsterSpawn', 'floorPatch'] as const) placeRecord(tool, { x: 3, z: 4, ...TAP_SIZE }, body, DEFAULTS);
    expect(body.placements).toEqual([{ id: 'box-1', modelId: 'box', x: 3, z: 4, yaw: 0, elevation: 0 }]);
    expect(body.blockers).toEqual([{ id: 'blocker-1', x: 3, z: 4, width: 1, depth: 1 }]);
    expect(body.npcs).toEqual([{ id: 'npc-1', name: '', characterModelId: 'hero', x: 3, z: 4, facing: 0, dialogScript: '' }]);
    expect(body.monsterSpawns).toEqual([{ id: 'spawn-1', kind: 'gespenst', x: 3, z: 4, width: 1, depth: 1, maxAlive: 1 }]);
    expect(body.floorPatches).toEqual([{ id: 'patch-1', floorMaterialId: 'cobble', x: 3, z: 4, width: 1, depth: 1 }]);
  });

  it('moves the one spawn point instead of adding a second, keeping its facing', () => {
    const body = emptySector({ spawn: { x: 1, z: 1, facing: 90 } });
    placeRecord('spawn', { x: 6, z: 7, ...TAP_SIZE }, body, DEFAULTS);
    expect(body.spawn).toEqual({ x: 6, z: 7, facing: 90 });
  });
});

describe('handles', () => {
  it('resolves the pressed handle by its projected screen rect', () => {
    const ctx = dragContext();
    const rect = { x: 2, z: 2, width: 4, depth: 4 };
    expect(hitHandle(viewportPoint({ x: 6, z: 6 }, ctx), rect, ctx)).toBe('bottomRight');
    expect(hitHandle(viewportPoint({ x: 4, z: 2 }, ctx), rect, ctx)).toBe('top');
    expect(hitHandle(viewportPoint({ x: 12, z: 12 }, ctx), rect, ctx)).toBeUndefined();
  });

  it('places the facing handle past the record along the heading', () => {
    const handle = facingHandlePoint({ x: 5, z: 5 }, 0.3, headingFromCardinal('east'), 0.5);
    expect(handle.x).toBeCloseTo(5.8, 6);
    expect(handle.z).toBeCloseTo(5, 6);
  });
});

describe('rotate', () => {
  it.each(['south', 'east', 'north', 'west'] as const)('a facing drag toward %s lands on its exact degrees', (direction) => {
    const ctx = dragContext();
    const center = { x: 8, z: 8 };
    const offset = { south: { x: 0, z: 3 }, east: { x: 3, z: 0 }, north: { x: 0, z: -3 }, west: { x: -3, z: 0 } }[direction];
    expect(headingFromDrag(viewportPoint({ x: center.x + offset.x, z: center.z + offset.z }, ctx), center, 45, ctx)).toBe(headingFromCardinal(direction));
  });

  it('lands on whole degrees inside the half-open range across the north-south seam', () => {
    const ctx = dragContext();
    const center = { x: 8, z: 8 };
    const turned = headingFromDrag(viewportPoint({ x: center.x - 0.01, z: center.z + 5 }, ctx), center, 45, ctx);
    expect(turned).toBe(0);
  });

  it('keeps the current heading for a drag onto the center itself', () => {
    const ctx = dragContext();
    expect(headingFromDrag(viewportPoint({ x: 8, z: 8 }, ctx), { x: 8, z: 8 }, 45, ctx)).toBe(45);
  });

  it.each([
    [0, 90],
    [90, 180],
    [270, 0],
  ])('shows a placement at yaw %s where its +X axis points, heading %s, and turns it back from there', (yaw, facing) => {
    const ctx = dragContext();
    const body = emptySector({ placements: [box('box-1', 5, 5, yaw)] });
    const selection: EditorSelection = { kind: 'placement', id: 'box-1' };
    expect(turnable(selection, body, ctx)).toEqual({ center: body.placements[0], reach: 1, facing });
    body.placements[0]!.yaw = 45;
    applyFacing(selection, facing, body);
    expect(body.placements[0]?.yaw).toBe(yaw);
  });

  it('turns an NPC and the spawn point by their facing', () => {
    const ctx = dragContext();
    const body = emptySector({ npcs: [npc({ x: 8, z: 8 }, 90)], spawn: { x: 2, z: 2, facing: 180 } });
    expect(turnable({ kind: 'npc', id: 'libus' }, body, ctx)).toMatchObject({ reach: SOMNIO_CONSTANTS.npcRadius, facing: 90 });
    expect(turnable({ kind: 'spawn', id: 'spawn' }, body, ctx)).toMatchObject({ reach: SOMNIO_CONSTANTS.playerRadius, facing: 180 });
    expect(turnable({ kind: 'blocker', id: 'none' }, body, ctx)).toBeUndefined();
    applyFacing({ kind: 'spawn', id: 'spawn' }, 270, body);
    expect(body.spawn?.facing).toBe(270);
  });
});

describe('marquee', () => {
  function boundingBox(corners: ScreenPoint[]): { x: number; y: number; width: number; height: number } {
    const xs = corners.map((corner) => corner.x);
    const ys = corners.map((corner) => corner.y);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
  }

  function quad(selection: EditorSelection, body: Sector, ctx: DragContext): ScreenPoint[] {
    return projectedCorners(footprintCorners(selectionFootprint(selection, body, ctx.registry)!), ctx);
  }

  it('selects records whose projected footprints intersect it', () => {
    const ctx = dragContext();
    const body = emptySector({ placements: [box('box-1', 2, 2)], blockers: [blocker('far', 16, 16)] });
    const hit = boundingBox(quad({ kind: 'placement', id: 'box-1' }, body, ctx));
    expect(marqueeSelections(body, { x: hit.x - 4, y: hit.y - 4, width: hit.width + 8, height: hit.height + 8 }, ctx)).toEqual([
      { kind: 'placement', id: 'box-1' },
    ]);
    expect(marqueeSelections(body, { x: -50, y: -50, width: 10, height: 10 }, ctx)).toEqual([]);
  });

  it('selects nothing inside the projected bounding box but outside the quad', () => {
    // The tilted camera projects a floor rect to a rotated quad; a marquee in the dead
    // corner of its bounding box must not select the record.
    const ctx = dragContext();
    const body = emptySector({ blockers: [blocker('wide', 0, 1, 10, 11)] });
    const corners = quad({ kind: 'blocker', id: 'wide' }, body, ctx);
    const bounds = boundingBox(corners);
    const deadCorner = { x: bounds.x + 1, y: bounds.y + 1, width: 2, height: 2 };
    expect(rectIntersectsConvexQuad(deadCorner, corners)).toBe(false);
    expect(marqueeSelections(body, deadCorner, ctx)).toEqual([]);
  });
});

describe('session classification', () => {
  it('begins a resize session on a selected rect record handle', () => {
    const ctx = dragContext();
    const body = emptySector({ blockers: [blocker('wall', 2, 2, 4, 4)] });
    const begun = beginSession(viewportPoint({ x: 6, z: 6 }, ctx), 'select', false, body, [{ kind: 'blocker', id: 'wall' }], ctx);
    expect(begun.session).toEqual({
      kind: 'resize',
      selection: { kind: 'blocker', id: 'wall' },
      handle: 'bottomRight',
      rect: { x: 2, z: 2, width: 4, depth: 4 },
    });
    expect(begun.selection).toEqual([{ kind: 'blocker', id: 'wall' }]);
  });

  it('gives a placement a facing handle and no resize handles', () => {
    const ctx = dragContext();
    const body = emptySector({ placements: [box('box-1', 8, 8)] });
    const selection: EditorSelection[] = [{ kind: 'placement', id: 'box-1' }];
    const handle = facingHandlePoint({ x: 8, z: 8 }, 1, 90, FACING_CLEARANCE_PT * metresPerViewportPoint(ctx));
    expect(beginSession(viewportPoint(handle, ctx), 'select', false, body, selection, ctx).session).toEqual({ kind: 'rotate', selection: selection[0] });
    // The footprint's corner is where a rect record would carry a resize handle.
    expect(beginSession(viewportPoint({ x: 9, z: 8.5 }, ctx), 'select', false, body, selection, ctx).session?.kind).toBe('move');
  });

  it('begins a rotate session on a selected NPC facing handle', () => {
    const ctx = dragContext();
    const subject = npc({ x: 8, z: 8 });
    const body = emptySector({ npcs: [subject] });
    const handle = facingHandlePoint(subject, SOMNIO_CONSTANTS.npcRadius, subject.facing, FACING_CLEARANCE_PT * metresPerViewportPoint(ctx));
    const begun = beginSession(viewportPoint(handle, ctx), 'select', false, body, [{ kind: 'npc', id: 'libus' }], ctx);
    expect(begun.session).toEqual({ kind: 'rotate', selection: { kind: 'npc', id: 'libus' } });
  });

  it('toggles membership on shift-click and starts no session', () => {
    const ctx = dragContext();
    const body = emptySector({ blockers: [blocker('a', 0, 0, 2, 2), blocker('b', 8, 8, 2, 2)] });
    const press = viewportPoint({ x: 9, z: 9 }, ctx);
    const added = beginSession(press, 'select', true, body, [{ kind: 'blocker', id: 'a' }], ctx);
    expect(added.session).toBeUndefined();
    expect(added.selection).toEqual([
      { kind: 'blocker', id: 'a' },
      { kind: 'blocker', id: 'b' },
    ]);
    const removed = beginSession(press, 'select', true, body, added.selection, ctx);
    expect(removed.session).toBeUndefined();
    expect(removed.selection).toEqual([{ kind: 'blocker', id: 'a' }]);
  });

  it('moves the whole selection when pressing a selected record', () => {
    const ctx = dragContext();
    const body = emptySector({ blockers: [blocker('a', 0, 0, 2, 2), blocker('b', 8, 8, 2, 2)] });
    const selection: EditorSelection[] = [
      { kind: 'blocker', id: 'a' },
      { kind: 'blocker', id: 'b' },
    ];
    const begun = beginSession(viewportPoint({ x: 1, z: 1 }, ctx), 'select', false, body, selection, ctx);
    expect(begun.session).toEqual({
      kind: 'move',
      originals: [
        { selection: selection[0], origin: { x: 0, z: 0 } },
        { selection: selection[1], origin: { x: 8, z: 8 } },
      ],
    });
    expect(begun.selection).toEqual(selection);
  });

  it('retargets the selection before moving when pressing an unselected record', () => {
    const ctx = dragContext();
    const body = emptySector({ blockers: [blocker('a', 0, 0, 2, 2), blocker('b', 8, 8, 2, 2)] });
    const begun = beginSession(viewportPoint({ x: 9, z: 9 }, ctx), 'select', false, body, [{ kind: 'blocker', id: 'a' }], ctx);
    expect(begun.session?.kind).toBe('move');
    expect(begun.selection).toEqual([{ kind: 'blocker', id: 'b' }]);
  });

  it('selects the prop on the first press, over the blocker and the selection beneath it', () => {
    const ctx = dragContext();
    const body = emptySector({ placements: [box('box-1', 5, 5)], blockers: [blocker('under', 0, 0, 10, 10)] });
    const begun = beginSession(viewportPoint({ x: 5.2, z: 5.2 }, ctx), 'select', false, body, [{ kind: 'blocker', id: 'under' }], ctx);
    expect(begun.session?.kind).toBe('move');
    expect(begun.selection).toEqual([{ kind: 'placement', id: 'box-1' }]);
  });

  it('clears the selection and starts a marquee on empty ground', () => {
    const ctx = dragContext();
    const body = emptySector({ blockers: [blocker('a', 0, 1, 10, 11)] });
    const begun = beginSession(viewportPoint({ x: 12.5, z: 9 }, ctx), 'select', false, body, [{ kind: 'blocker', id: 'a' }], ctx);
    expect(begun.session).toEqual({ kind: 'marquee' });
    expect(begun.selection).toEqual([]);
  });

  it('anchors a placement at the quantized press point of a sector that stands away from the origin', () => {
    const ctx = dragContext(0.5, { x: 5.12, z: -30.72 });
    const begun = beginSession(viewportPoint({ x: 3.2, z: 4.8 }, ctx), 'npc', false, emptySector(), [], ctx);
    expect(begun.session).toEqual({ kind: 'placement', tool: 'npc', anchor: { x: 3, z: 5 } });
  });
});

describe('commit guards', () => {
  it('commits no mutation and registers no undo step on a zero-travel move', () => {
    const ctx = dragContext();
    const document = documentWith(emptySector({ blockers: [blocker('a', 2, 2, 2, 2)] }));
    const before = document.undoDepth;
    const press = viewportPoint({ x: 2.5, z: 2.5 }, ctx);
    const selection: EditorSelection[] = [{ kind: 'blocker', id: 'a' }];
    endSession({ kind: 'move', originals: origins(selection, document.sector) }, press, press, false, document, document.sector, selection, ctx, DEFAULTS);
    expect(document.sector.blockers[0]).toEqual(blocker('a', 2, 2, 2, 2));
    expect(document.undoDepth).toBe(before);
  });

  it('registers no undo step on a drag of a door on its own, which has no position to move', () => {
    const ctx = dragContext();
    const document = documentWith(
      emptySector({
        placements: [{ id: 'door-1', modelId: 'door', x: 10, z: 19, yaw: 0, elevation: 0 }],
        doors: [{ id: 'exit', placement: 'door-1', anchor: 'main', target: { sector: 'Other', door: 'in' } }],
      }),
    );
    const before = document.undoDepth;
    const press = viewportPoint({ x: 10, z: 18.7 }, ctx);
    const release = viewportPoint({ x: 13, z: 15 }, ctx);
    const begun = beginSession(press, 'select', false, document.sector, [], ctx);
    expect(begun).toEqual({ session: { kind: 'move', originals: [] }, selection: [{ kind: 'door', id: 'exit' }] });
    expect(gridDelta(press, release, ctx)).toEqual({ dx: 3, dz: -3.5 });
    expect(endSession(begun.session!, press, release, false, document, document.sector, begun.selection, ctx, DEFAULTS)).toEqual(begun.selection);
    expect(document.undoDepth).toBe(before);
  });

  it('appends, selects, and registers one undo step on a placement commit', () => {
    const ctx = dragContext();
    const document = documentWith(emptySector());
    const before = document.undoDepth;
    const press = viewportPoint({ x: 2.1, z: 2.1 }, ctx);
    const selection = endSession(
      { kind: 'placement', tool: 'blocker', anchor: { x: 2, z: 2 } },
      press,
      press,
      false,
      document,
      document.sector,
      [],
      ctx,
      DEFAULTS,
    );
    expect(document.sector.blockers).toEqual([{ id: 'blocker-1', x: 2, z: 2, width: 1, depth: 1 }]);
    expect(selection).toEqual([{ kind: 'blocker', id: 'blocker-1' }]);
    expect(document.undoDepth).toBe(before + 1);
  });

  it('keeps the selection when the document refuses the placement', () => {
    const ctx = dragContext();
    const patch = { id: 'patch-1', floorMaterialId: 'cobble', x: 2, z: 2, width: 2, depth: 2 };
    const document = documentWith(emptySector({ floorPatches: [patch] }));
    const before = document.undoDepth;
    const press = viewportPoint({ x: 3, z: 3 }, ctx);
    const kept: EditorSelection[] = [{ kind: 'floorPatch', id: 'patch-1' }];
    const selection = endSession(
      { kind: 'placement', tool: 'floorPatch', anchor: { x: 3, z: 3 } },
      press,
      press,
      false,
      document,
      document.sector,
      kept,
      ctx,
      DEFAULTS,
    );
    expect(selection).toEqual(kept);
    expect(document.sector.floorPatches).toEqual([patch]);
    expect(document.undoDepth).toBe(before);
  });

  it('commits no mutation on a zero-travel resize', () => {
    const ctx = dragContext();
    const document = documentWith(emptySector({ blockers: [blocker('a', 2, 2, 2, 2)] }));
    const before = document.undoDepth;
    const press = viewportPoint({ x: 4, z: 4 }, ctx);
    const session: DragSession = { kind: 'resize', selection: { kind: 'blocker', id: 'a' }, handle: 'bottomRight', rect: { x: 2, z: 2, width: 2, depth: 2 } };
    endSession(session, press, press, false, document, document.sector, [], ctx, DEFAULTS);
    expect(document.sector.blockers[0]).toEqual(blocker('a', 2, 2, 2, 2));
    expect(document.undoDepth).toBe(before);
  });

  it('commits no undo step on a rotate back to the current heading', () => {
    const ctx = dragContext();
    const subject = npc({ x: 8, z: 8 });
    const document = documentWith(emptySector({ npcs: [subject] }));
    const before = document.undoDepth;
    const handle = viewportPoint({ x: 8, z: 10 }, ctx);
    endSession({ kind: 'rotate', selection: { kind: 'npc', id: 'libus' } }, handle, handle, false, document, document.sector, [], ctx, DEFAULTS);
    expect(document.sector.npcs[0]?.facing).toBe(subject.facing);
    expect(document.undoDepth).toBe(before);
  });

  it('neither throws nor mutates on a rotate against a record that is gone', () => {
    const ctx = dragContext();
    const document = documentWith(emptySector());
    const before = structuredClone(document.sector);
    const depth = document.undoDepth;
    const session: DragSession = { kind: 'rotate', selection: { kind: 'npc', id: 'gone' } };
    endSession(session, viewportPoint({ x: 5, z: 5 }, ctx), viewportPoint({ x: 9, z: 9 }, ctx), false, document, document.sector, [], ctx, DEFAULTS);
    expect(document.sector).toEqual(before);
    expect(document.undoDepth).toBe(depth);
  });

  it('unions an additive marquee with the existing selection', () => {
    const ctx = dragContext();
    const document = documentWith(emptySector({ blockers: [blocker('a', 0, 0), blocker('b', 16, 16)] }));
    const corners = projectedCorners(footprintCorners(selectionFootprint({ kind: 'blocker', id: 'b' }, document.sector, ctx.registry)!), ctx);
    const xs = corners.map((corner) => corner.x);
    const ys = corners.map((corner) => corner.y);
    const start = { x: Math.min(...xs) - 4, y: Math.min(...ys) - 4 };
    const end = { x: Math.max(...xs) + 4, y: Math.max(...ys) + 4 };
    const selection = endSession({ kind: 'marquee' }, start, end, true, document, document.sector, [{ kind: 'blocker', id: 'a' }], ctx, DEFAULTS);
    expect(selection).toEqual([
      { kind: 'blocker', id: 'a' },
      { kind: 'blocker', id: 'b' },
    ]);
  });
});

describe('preview against the commit', () => {
  const body = emptySector({
    placements: [box('box-1', 5, 5)],
    blockers: [blocker('wall', 10, 2, 2, 2)],
    npcs: [npc({ x: 8, z: 12 })],
  });

  const cases: [string, DragSession, Point, Point][] = [
    ['a move', { kind: 'move', originals: origins([{ kind: 'placement', id: 'box-1' }], body) }, { x: 5, z: 5 }, { x: 7.3, z: 3.9 }],
    [
      'a resize',
      { kind: 'resize', selection: { kind: 'blocker', id: 'wall' }, handle: 'bottomRight', rect: { x: 10, z: 2, width: 2, depth: 2 } },
      { x: 12, z: 4 },
      { x: 13.4, z: 6.2 },
    ],
    ['a placement turn', { kind: 'rotate', selection: { kind: 'placement', id: 'box-1' } }, { x: 6.5, z: 5 }, { x: 4, z: 2 }],
    ['an NPC turn', { kind: 'rotate', selection: { kind: 'npc', id: 'libus' } }, { x: 8, z: 13 }, { x: 11, z: 10 }],
    ['a rubber-banded rect', { kind: 'placement', tool: 'monsterSpawn', anchor: { x: 14, z: 14 } }, { x: 14, z: 14 }, { x: 17.2, z: 18.6 }],
    ['a placed model', { kind: 'placement', tool: 'placement', anchor: { x: 15, z: 3 } }, { x: 15, z: 3 }, { x: 15, z: 3 }],
  ];

  it.each(cases)('draws %s where releasing at the same point commits it', (_name, session, from, to) => {
    const ctx = dragContext();
    const document = documentWith(body);
    const start = viewportPoint(from, ctx);
    const end = viewportPoint(to, ctx);
    const shown = preview(session, start, end, document.sector, ctx, DEFAULTS);
    endSession(session, start, end, false, document, document.sector, [], ctx, DEFAULTS);
    expect(shown).toBeDefined();
    expect(document.sector).not.toEqual(body);
    expect(document.sector).toEqual(shown);
  });

  it('turns to the heading the pointer is at, in whole degrees', () => {
    const ctx = dragContext();
    const document = documentWith(body);
    const session: DragSession = { kind: 'rotate', selection: { kind: 'npc', id: 'libus' } };
    const end = viewportPoint({ x: 11, z: 10 }, ctx);
    endSession(session, end, end, false, document, document.sector, [], ctx, DEFAULTS);
    const turned = document.sector.npcs[0]!.facing;
    expect(Number.isInteger(turned)).toBe(true);
    expect(Math.abs(angularDistance(turned, 124))).toBeLessThan(1);
  });

  it('has no floor-space preview for a marquee', () => {
    const ctx = dragContext();
    const point = viewportPoint({ x: 1, z: 1 }, ctx);
    expect(preview({ kind: 'marquee' }, point, point, body, ctx, DEFAULTS)).toBeUndefined();
  });
});
