import { describe, expect, it } from 'vitest';
import { captureClipboard, insertClipboard, isClipboardEmpty } from '@/editor/clipboard';
import { emptySector } from './helpers/editorFixture';

/**
 * The clipboard over the in-page record buffer — anchor placement, duplicate offsets, fresh ids,
 * doors following their placement, and source-order capture.
 */

const house = { id: 'house-1', modelId: 'house', x: 6, z: 6, yaw: 90, elevation: 0 };
const door = { id: 'to-shop', placement: 'house-1', anchor: 'main', target: { sector: 'Shop', door: 'exit' } };

describe('paste placement', () => {
  it('anchors the payload bounding corner at the cursor, preserving offsets', () => {
    const source = emptySector({ placements: [house], blockers: [{ id: 'blocker-1', x: 7, z: 9, width: 1, depth: 1 }] });
    const clipboard = captureClipboard(
      [
        { kind: 'placement', id: 'house-1' },
        { kind: 'blocker', id: 'blocker-1' },
      ],
      source,
    );
    const target = emptySector();
    const inserted = insertClipboard(clipboard, target, { x: 12, z: 12 }, 0.5);
    expect(inserted).toEqual([
      { kind: 'placement', id: 'house-1' },
      { kind: 'blocker', id: 'blocker-1' },
    ]);
    expect(target.placements).toEqual([{ ...house, x: 12, z: 12 }]);
    expect(target.blockers[0]).toMatchObject({ x: 13, z: 15 });
  });

  it('offsets every clone by the fallback step on duplicate and gives it the next free id', () => {
    const body = emptySector({
      npcs: [{ id: 'npc-1', name: 'Libus', characterModelId: 'libus', x: 5.12, z: 5.12, facing: 90, dialogScript: 'Hallo' }],
      monsterSpawns: [{ id: 'spawn-1', kind: 'gespenst', x: 1, z: 1, width: 2, depth: 2, maxAlive: 3 }],
      floorPatches: [{ id: 'patch-1', floorMaterialId: 'cobble', x: 0, z: 10, width: 2, depth: 2 }],
    });
    const selection = [
      { kind: 'npc', id: 'npc-1' },
      { kind: 'monsterSpawn', id: 'spawn-1' },
      { kind: 'floorPatch', id: 'patch-1' },
    ] as const;
    expect(insertClipboard(captureClipboard(selection, body), body, undefined, 0.1)).toEqual([
      { kind: 'npc', id: 'npc-2' },
      { kind: 'monsterSpawn', id: 'spawn-2' },
      { kind: 'floorPatch', id: 'patch-2' },
    ]);
    expect(body.npcs[1]).toEqual({ ...body.npcs[0], id: 'npc-2', x: 5.22, z: 5.22 });
    expect(body.monsterSpawns[1]).toEqual({ ...body.monsterSpawns[0], id: 'spawn-2', x: 1.1, z: 1.1 });
    expect(body.floorPatches[1]).toEqual({ ...body.floorPatches[0], id: 'patch-2', x: 0.1, z: 10.1 });
  });

  it('attaches a pasted door to the pasted placement', () => {
    const body = emptySector({ placements: [house], doors: [door] });
    const clipboard = captureClipboard(
      [
        { kind: 'door', id: 'to-shop' },
        { kind: 'placement', id: 'house-1' },
      ],
      body,
    );
    const inserted = insertClipboard(clipboard, body, undefined, 1);
    expect(inserted).toEqual([
      { kind: 'placement', id: 'house-2' },
      { kind: 'door', id: 'to-shop-1' },
    ]);
    expect(body.doors).toEqual([door, { ...door, id: 'to-shop-1', placement: 'house-2' }]);
    // The original keeps its own placement and target.
    expect(body.placements.map((placement) => placement.id)).toEqual(['house-1', 'house-2']);
  });
});

describe('capture', () => {
  it('leaves out a door copied without its placement', () => {
    const body = emptySector({ placements: [house], doors: [door] });
    expect(isClipboardEmpty(captureClipboard([{ kind: 'door', id: 'to-shop' }], body))).toBe(true);
    expect(captureClipboard([{ kind: 'placement', id: 'house-1' }], body).doors).toEqual([]);
  });

  it('skips selections of records that are gone, and the one spawn point', () => {
    const blockers = [{ id: 'blocker-1', x: 0, z: 0, width: 1, depth: 1 }];
    const source = emptySector({ blockers, spawn: { x: 1, z: 1, facing: 0 } });
    const clipboard = captureClipboard(
      [
        { kind: 'blocker', id: 'blocker-1' },
        { kind: 'blocker', id: 'gone' },
        { kind: 'npc', id: 'gone' },
        { kind: 'spawn', id: 'spawn' },
      ],
      source,
    );
    expect(clipboard).toEqual({ placements: [], blockers, doors: [], npcs: [], monsterSpawns: [], floorPatches: [] });
  });

  it('preserves source-array order so pasted stacking cannot shuffle, and copies rather than aliases', () => {
    const blockers = ['a', 'b', 'c'].map((id, index) => ({ id, x: index, z: index, width: 4, depth: 4 }));
    const source = emptySector({ blockers });
    const clipboard = captureClipboard(
      [
        { kind: 'blocker', id: 'c' },
        { kind: 'blocker', id: 'a' },
        { kind: 'blocker', id: 'b' },
      ],
      source,
    );
    expect(clipboard.blockers).toEqual(blockers);
    source.blockers[0]!.x = 99;
    expect(clipboard.blockers[0]?.x).toBe(0);
  });
});
