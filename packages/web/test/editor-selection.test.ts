import { describe, expect, it } from 'vitest';
import type { Sector } from '@somnio/core';
import { EDITOR_TOOLS, candidateSelections, nudgeDelta, selectRecord } from '@/editor/canvasController';
import {
  footprintContains,
  footprintCorners,
  isValidId,
  isValidSelection,
  nextDoorId,
  nextFreeId,
  removeAllSelections,
  renameRecord,
  selectionFootprint,
  selectionsEqual,
  toggleSelection,
} from '@/editor/selection';
import type { EditorSelection } from '@/editor/selection';
import { CursorReadout } from '@/editor/ui/cursorReadout';
import { TEST_REGISTRY, interiorSector } from '../../core/test/support/worldFixture.ts';

/**
 * Selection, cursor-readout, pick-ordering, id, and nudge cases — over the seven kinds.
 */

function populatedSector(overrides: Partial<Sector> = {}): Sector {
  return interiorSector('Test', {
    size: { width: 20, depth: 20 },
    placements: [
      { id: 'door-1', modelId: 'door', x: 10, z: 19, yaw: 0, elevation: 0 },
      { id: 'box-1', modelId: 'box', x: 4, z: 4, yaw: 0, elevation: 0 },
    ],
    blockers: [{ id: 'blocker-1', x: 0, z: 0, width: 2, depth: 1 }],
    doors: [{ id: 'exit', placement: 'door-1', anchor: 'main', target: { sector: 'Other', door: 'in' } }],
    floorPatches: [{ id: 'patch-1', floorMaterialId: 'cobble', x: 12, z: 2, width: 3, depth: 2 }],
    spawn: { x: 6, z: 12, facing: 0 },
    npcs: [{ id: 'libus', name: 'Libus', characterModelId: 'hero', x: 2, z: 12, facing: 0, dialogScript: '' }],
    monsterSpawns: [{ id: 'spawn-1', kind: 'gespenst', x: 12, z: 12, width: 4, depth: 4, maxAlive: 3 }],
    ...overrides,
  });
}

const ALL: EditorSelection[] = [
  { kind: 'placement', id: 'box-1' },
  { kind: 'blocker', id: 'blocker-1' },
  { kind: 'door', id: 'exit' },
  { kind: 'npc', id: 'libus' },
  { kind: 'monsterSpawn', id: 'spawn-1' },
  { kind: 'floorPatch', id: 'patch-1' },
  { kind: 'spawn', id: 'spawn' },
];

describe('selection validity and footprints', () => {
  it.each(ALL)('a $kind selection reports valid and resolves a footprint', (selection) => {
    expect(isValidSelection(selection, populatedSector())).toBe(true);
    expect(selectionFootprint(selection, populatedSector(), TEST_REGISTRY)).toBeDefined();
  });

  it.each(ALL)('a $kind selection of a record that is gone reports invalid with no footprint', ({ kind }) => {
    const selection: EditorSelection = { kind, id: 'gone' };
    const body = populatedSector();
    delete body.spawn;
    expect(isValidSelection(selection, body)).toBe(false);
    expect(selectionFootprint(selection, body, TEST_REGISTRY)).toBeUndefined();
  });

  it.each([
    ['npc', 'libus', { x: 2, z: 12 }],
    ['spawn', 'spawn', { x: 6, z: 12 }],
  ] as const)('gives the %s a square a body radius to every side of where it stands', (kind, id, at) => {
    const body = populatedSector();
    const footprint = selectionFootprint({ kind, id }, body, TEST_REGISTRY)!;
    expect(footprint.transform).toEqual({ x: 0, z: 0, yaw: 0 });
    expect(footprint.rect).toEqual({
      x: expect.closeTo(at.x - 0.3, 9),
      z: expect.closeTo(at.z - 0.3, 9),
      width: expect.closeTo(0.6, 9),
      depth: expect.closeTo(0.6, 9),
    });
    const pick = (dx: number, dz: number): EditorSelection | undefined => selectRecord({ x: at.x + dx, z: at.z + dz }, body, TEST_REGISTRY);
    for (const [dx, dz] of [
      [0.29, 0],
      [-0.29, 0],
      [0, 0.29],
      [0, -0.29],
    ] as const)
      expect(pick(dx, dz)).toEqual({ kind, id });
    for (const [dx, dz] of [
      [0.31, 0],
      [-0.31, 0],
      [0, 0.31],
      [0, -0.31],
    ] as const)
      expect(pick(dx, dz)).toBeUndefined();
  });

  it('turns a placement footprint by its yaw', () => {
    const body = populatedSector({ placements: [{ id: 'box-1', modelId: 'box', x: 4, z: 4, yaw: 90, elevation: 0 }], doors: [] });
    const footprint = selectionFootprint({ kind: 'placement', id: 'box-1' }, body, TEST_REGISTRY)!;
    // The 2 x 1 box stands on end: 1 wide and 2 deep.
    expect(footprintContains(footprint, { x: 4, z: 4.9 })).toBe(true);
    expect(footprintContains(footprint, { x: 4.9, z: 4 })).toBe(false);
    const xs = footprintCorners(footprint).map((corner) => corner.x);
    expect(Math.min(...xs)).toBeCloseTo(3.5, 9);
    expect(Math.max(...xs)).toBeCloseTo(4.5, 9);
  });

  it('gives a door its trigger in front of the anchor, and nothing when the model has no such anchor', () => {
    const body = populatedSector();
    // The test door opens toward -Z: the trigger reaches north of the placement at z 19.
    const footprint = selectionFootprint({ kind: 'door', id: 'exit' }, body, TEST_REGISTRY)!;
    expect(footprintContains(footprint, { x: 10, z: 18.6 })).toBe(true);
    expect(footprintContains(footprint, { x: 10, z: 19.4 })).toBe(false);
    body.doors[0]!.anchor = 'side';
    expect(isValidSelection({ kind: 'door', id: 'exit' }, body)).toBe(true);
    expect(selectionFootprint({ kind: 'door', id: 'exit' }, body, TEST_REGISTRY)).toBeUndefined();
  });

  it('falls back to the placeholder size for a model the registry does not know', () => {
    const body = populatedSector({ placements: [{ id: 'odd-1', modelId: 'odd', x: 4, z: 4, yaw: 0, elevation: 0 }], doors: [] });
    expect(selectionFootprint({ kind: 'placement', id: 'odd-1' }, body, TEST_REGISTRY)?.rect).toMatchObject({ width: 0.64, depth: 0.64 });
  });
});

describe('removeAllSelections', () => {
  it('covers every kind', () => {
    const body = populatedSector();
    removeAllSelections([...ALL, { kind: 'placement', id: 'door-1' }], body);
    expect(body).toMatchObject({ placements: [], blockers: [], doors: [], npcs: [], monsterSpawns: [], floorPatches: [] });
    expect(body.spawn).toBeUndefined();
  });

  it('skips records that are gone and leaves the body unchanged', () => {
    const body = populatedSector();
    const before = structuredClone(body);
    removeAllSelections([{ kind: 'npc', id: 'gone' }], body);
    expect(body).toEqual(before);
  });

  it('takes a placement and its doors together', () => {
    const body = populatedSector();
    removeAllSelections([{ kind: 'placement', id: 'door-1' }], body);
    expect(body.placements.map((placement) => placement.id)).toEqual(['box-1']);
    expect(body.doors).toEqual([]);
  });
});

describe('ids', () => {
  it('generates the next free numbered id, filling a gap', () => {
    expect(nextFreeId('blocker', [])).toBe('blocker-1');
    expect(nextFreeId('blocker', [{ id: 'blocker-1' }, { id: 'blocker-3' }])).toBe('blocker-2');
    expect(nextFreeId('building-house', [{ id: 'building-house-1' }, { id: 'building-house-2' }])).toBe('building-house-3');
  });

  it('names a door for its target sector and numbers it otherwise', () => {
    expect(nextDoorId('EdariaShop', [])).toBe('to-edariashop');
    expect(nextDoorId('EdariaShop', [{ id: 'to-edariashop' }])).toBe('to-edariashop-1');
    expect(nextDoorId('Nordwiese Süd', [])).toBe('to-nordwiese-s-d');
    expect(nextDoorId('', [{ id: 'door-1' }])).toBe('door-2');
  });

  it('holds an id to the rule the sector codec applies', () => {
    expect(isValidId('to-edariashop')).toBe(true);
    expect(isValidId('')).toBe(false);
    expect(isValidId('Townhall')).toBe(false);
    expect(isValidId('a b')).toBe(false);
    expect(isValidId('a'.repeat(65))).toBe(false);
  });

  it('re-points the doors of a renamed placement and of nothing else', () => {
    const body = populatedSector();
    renameRecord({ kind: 'placement', id: 'door-1' }, 'gate', body);
    expect(body.placements[0]?.id).toBe('gate');
    expect(body.doors[0]?.placement).toBe('gate');
    renameRecord({ kind: 'blocker', id: 'blocker-1' }, 'north-wall', body);
    expect(body.blockers[0]?.id).toBe('north-wall');
    expect(body.doors[0]?.placement).toBe('gate');
  });
});

describe('set helpers', () => {
  it('toggles membership and compares order-independently', () => {
    const list: EditorSelection[] = [{ kind: 'blocker', id: 'a' }];
    const added = toggleSelection(list, { kind: 'placement', id: 'a' });
    expect(added.length).toBe(2);
    expect(toggleSelection(added, { kind: 'blocker', id: 'a' })).toEqual([{ kind: 'placement', id: 'a' }]);
    expect(
      selectionsEqual(
        [
          { kind: 'blocker', id: 'a' },
          { kind: 'placement', id: 'b' },
        ],
        [
          { kind: 'placement', id: 'b' },
          { kind: 'blocker', id: 'a' },
        ],
      ),
    ).toBe(true);
  });
});

describe('pick ordering', () => {
  it('orders the markers and door triggers before placements, and placements before every authored rect', () => {
    const kinds = candidateSelections(populatedSector()).map((selection) => selection.kind);
    expect(kinds).toEqual(['npc', 'spawn', 'door', 'placement', 'placement', 'blocker', 'monsterSpawn', 'floorPatch']);
  });

  it('picks what stands on top at a point, and the latest record within a kind', () => {
    const overlap = populatedSector({
      placements: [
        { id: 'rug-1', modelId: 'rug', x: 5, z: 5, yaw: 0, elevation: 0 },
        { id: 'rug-2', modelId: 'rug', x: 5.5, z: 5, yaw: 0, elevation: 0 },
      ],
      doors: [],
      blockers: [{ id: 'blocker-1', x: 0, z: 0, width: 10, depth: 10 }],
      npcs: [{ id: 'libus', name: 'Libus', characterModelId: 'hero', x: 4.5, z: 5, facing: 0, dialogScript: '' }],
      monsterSpawns: [{ id: 'spawn-1', kind: 'gespenst', x: 0, z: 0, width: 12, depth: 12, maxAlive: 3 }],
      floorPatches: [{ id: 'patch-1', floorMaterialId: 'cobble', x: 0, z: 0, width: 14, depth: 14 }],
    });
    const pick = (x: number, z: number): EditorSelection | undefined => selectRecord({ x, z }, overlap, TEST_REGISTRY);
    // On the NPC, which stands on the first rug.
    expect(pick(4.5, 5)).toEqual({ kind: 'npc', id: 'libus' });
    // On both rugs, clear of the NPC: the most recently placed one.
    expect(pick(5.2, 5.4)).toEqual({ kind: 'placement', id: 'rug-2' });
    expect(pick(8, 8)).toEqual({ kind: 'blocker', id: 'blocker-1' });
    expect(pick(11, 11)).toEqual({ kind: 'monsterSpawn', id: 'spawn-1' });
    expect(pick(13, 13)).toEqual({ kind: 'floorPatch', id: 'patch-1' });
    expect(pick(15, 15)).toBeUndefined();
  });

  it('picks a door by its trigger and its placement beside it', () => {
    const body = populatedSector();
    expect(selectRecord({ x: 10, z: 18.7 }, body, TEST_REGISTRY)).toEqual({ kind: 'door', id: 'exit' });
    expect(selectRecord({ x: 10, z: 19.05 }, body, TEST_REGISTRY)).toEqual({ kind: 'placement', id: 'door-1' });
  });

  it('pins the tools to their literals', () => {
    expect([...EDITOR_TOOLS]).toEqual(['select', 'placement', 'blocker', 'npc', 'monsterSpawn', 'floorPatch', 'spawn']);
  });
});

describe('nudgeDelta', () => {
  it('maps arrow keys to one-centimetre deltas', () => {
    expect(nudgeDelta('ArrowUp', false, 0.5)).toEqual({ dx: 0, dz: -0.01 });
    expect(nudgeDelta('ArrowDown', false, 0.5)).toEqual({ dx: 0, dz: 0.01 });
    expect(nudgeDelta('ArrowLeft', false, 0.5)).toEqual({ dx: -0.01, dz: 0 });
    expect(nudgeDelta('ArrowRight', false, 0.5)).toEqual({ dx: 0.01, dz: 0 });
  });

  it('scales the nudge to the grid step under shift, and stays a centimetre while the grid is free', () => {
    expect(nudgeDelta('ArrowRight', true, 0.25)).toEqual({ dx: 0.25, dz: 0 });
    expect(nudgeDelta('ArrowDown', true, 0)).toEqual({ dx: 0, dz: 0.01 });
  });

  it('resolves no nudge for a non-arrow key', () => {
    expect(nudgeDelta(' ', false, 0.5)).toBeUndefined();
  });
});

describe('CursorReadout', () => {
  it('tracks a single selection footprint size and shows metres', () => {
    const readout = new CursorReadout();
    readout.applyBounds([{ kind: 'blocker', id: 'blocker-1' }], populatedSector(), TEST_REGISTRY);
    expect([readout.width, readout.depth]).toEqual([2, 1]);
    readout.x = 3.5;
    readout.render('Test');
    expect(readout.root.textContent).toBe('X: 3.50  Z: 0.00  W: 2.00  D: 1.00  Test');
  });

  it('clears the size readout for a multi-selection, an empty one, and a record that is gone', () => {
    const readout = new CursorReadout();
    const selections: EditorSelection[][] = [
      [
        { kind: 'blocker', id: 'blocker-1' },
        { kind: 'placement', id: 'box-1' },
      ],
      [],
      [{ kind: 'blocker', id: 'gone' }],
    ];
    for (const selection of selections) {
      readout.applyBounds([{ kind: 'blocker', id: 'blocker-1' }], populatedSector(), TEST_REGISTRY);
      readout.applyBounds(selection, populatedSector(), TEST_REGISTRY);
      expect([readout.width, readout.depth]).toEqual([0, 0]);
    }
  });
});
