import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Sector } from '@somnio/core';
import { EditorDocument, applySectorSettings, sectorSettings } from '@/editor/document';
import { DEFAULT_GRID_SNAP, GRID_SNAP_PRESETS, currentGridSnap, persistGridSnap, quantize, stepOrFine } from '@/editor/preferences';
import { readSectorFixture } from '../../core/test/support/sectorFixture.ts';
import { SETTINGS } from './helpers/editorFixture';

/**
 * The document/undo model and the grid-snap preference: whole-body snapshots through one
 * validating funnel, the saved-checkpoint dirty rule, the floor-patch overlap guard, and the
 * grid-snap absent-vs-zero guard.
 */

function initializedDocument(): EditorDocument {
  const document = new EditorDocument();
  document.create(SETTINGS);
  return document;
}

function blocker(id: string, x = 0) {
  return { id, x, z: 0, width: 1, depth: 1 };
}

function patch(id: string, x: number) {
  return { id, floorMaterialId: 'cobble-town', x, z: 0, width: 2, depth: 2 };
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response): void {
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => Promise.resolve(handler(String(input), init)));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mutate / undo / redo', () => {
  it('is symmetric across N steps', () => {
    const document = initializedDocument();
    document.mutate('Place blocker', (sector) => {
      sector.blockers.push(blocker('wall'));
    });
    document.mutate('Move selection', (sector) => {
      sector.blockers[0]!.x = 4;
    });
    expect(document.sector.blockers[0]?.x).toBe(4);
    document.undo();
    expect(document.sector.blockers[0]?.x).toBe(0);
    document.undo();
    expect(document.sector.blockers).toEqual([]);
    document.redo();
    expect(document.sector.blockers[0]?.x).toBe(0);
    document.redo();
    expect(document.sector.blockers[0]?.x).toBe(4);
  });

  it('keeps history apart from the live body, so a later nested mutation cannot edit it in place', () => {
    const document = initializedDocument();
    document.mutate('Set spawn point', (sector) => {
      sector.spawn = { x: 1, z: 1, facing: 0 };
    });
    document.mutate('Edit spawn point', (sector) => {
      sector.spawn!.x = 9;
    });
    document.undo();
    expect(document.sector.spawn?.x).toBe(1);
    document.redo();
    expect(document.sector.spawn?.x).toBe(9);
  });

  it('takes a commit that changes nothing as accepted, with no undo step, no cleared redo, and no notification', () => {
    const document = initializedDocument();
    document.mutate('Place blocker', (sector) => {
      sector.blockers.push(blocker('wall'));
    });
    document.mutate('Move selection', (sector) => {
      sector.blockers[0]!.x = 4;
    });
    document.undo();
    const depth = document.undoDepth;
    const changed = vi.fn();
    document.onChanged = changed;
    const unmoved = document.mutate('Move selection', (sector) => {
      sector.blockers[0]!.x = 0;
    });
    expect(unmoved).toEqual({ accepted: true });
    expect(document.commit('Paste', structuredClone(document.sector))).toEqual({ accepted: true });
    expect(document.undoDepth).toBe(depth);
    expect(document.canRedo).toBe(true);
    expect(changed).not.toHaveBeenCalled();

    document.mutate('Move selection', (sector) => {
      sector.blockers[0]!.x = 1;
    });
    expect(document.undoDepth).toBe(depth + 1);
    expect(document.canRedo).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('clears the redo stack on a fresh mutation', () => {
    const document = initializedDocument();
    document.mutate('Place blocker', (sector) => {
      sector.blockers.push(blocker('wall'));
    });
    document.undo();
    document.mutate('Place blocker', (sector) => {
      sector.blockers.push(blocker('fence'));
    });
    expect(document.canRedo).toBe(false);
  });
});

describe('commit', () => {
  it('applies a change exactly once', () => {
    const document = initializedDocument();
    let applied = 0;
    document.mutate('Count', (sector) => {
      applied += 1;
      sector.blockers.push(blocker(`blocker-${applied}`));
    });
    expect(applied).toBe(1);
    expect(document.sector.blockers.map((entry) => entry.id)).toEqual(['blocker-1']);
  });

  it.each<[string, (sector: Sector) => void, RegExp]>([
    ['a duplicate id', (sector) => sector.blockers.push(blocker('wall')), /duplicate id "wall"/],
    ['an id the codec does not allow', (sector) => (sector.blockers[0]!.id = 'North Wall'), /lowercase letters, digits, and hyphens/],
    ['a rect with no extent', (sector) => (sector.blockers[0]!.width = 0), /width/],
    [
      'a door in no placement',
      (sector) => sector.doors.push({ id: 'exit', placement: 'gone', anchor: 'main', target: { sector: 'A', door: 'b' } }),
      /no placement/,
    ],
    ['a brightness on an outdoor sector', (sector) => (sector.brightness = 50), /brightness/],
  ])('refuses %s with the codec reason and leaves the document and its history alone', (_name, change, reason) => {
    const document = initializedDocument();
    document.mutate('Place blocker', (sector) => {
      sector.blockers.push(blocker('wall'));
    });
    const before = structuredClone(document.sector);
    const depth = document.undoDepth;
    const result = document.mutate('Break', change);
    expect(result.accepted).toBe(false);
    expect(result.accepted ? '' : result.message).toMatch(reason);
    expect(document.sector).toEqual(before);
    expect(document.undoDepth).toBe(depth);
  });

  it.each<[string, ReturnType<typeof patch>[], (sector: Sector) => void, boolean]>([
    ['refuses a move that slides one patch over another', [patch('a', 0), patch('b', 2)], (sector) => (sector.floorPatches[0]!.x = 0.01), false],
    ['allows patches that only touch', [patch('a', 0), patch('b', 4)], (sector) => (sector.floorPatches[0]!.x = 2), true],
    ['refuses a new patch over an existing one', [patch('a', 0)], (sector) => sector.floorPatches.push(patch('b', 1)), false],
    // A file that already carries an overlap still edits elsewhere.
    ['allows an edit beside an overlap the body already had', [patch('a', 0), patch('b', 1), patch('c', 8)], (sector) => (sector.floorPatches[2]!.x = 9), true],
    ['allows renaming and deleting around an overlap the body already had', [patch('a', 0), patch('b', 1), patch('c', 8)], renameAndDelete, true],
    [
      'refuses a second overlap in a body that already had one',
      [patch('a', 0), patch('b', 1), patch('c', 8)],
      (sector) => (sector.floorPatches[2]!.x = 2.5),
      false,
    ],
    // A and B overlap and C touches B: moving B resolves A-B but creates B-C, so the count stays at one.
    ['refuses trading one overlap for a different one', [patch('a', 0), patch('b', 1.9), patch('c', 3.9)], (sector) => (sector.floorPatches[1]!.x = 2), false],
  ])('%s', (_name, patches, change, accepted) => {
    const document = initializedDocument();
    // Loaded, not committed: a file is never refused for what it already carries.
    document.sector.floorPatches = structuredClone(patches);
    const result = document.mutate('Edit', change);
    expect(result.accepted).toBe(accepted);
    if (!result.accepted) expect(result.message).toBe('Floor patches must not overlap.');
  });

  function renameAndDelete(sector: Sector): void {
    sector.floorPatches[1]!.id = 'renamed';
    sector.floorPatches.splice(2, 1);
  }
});

describe('dirty checkpoint', () => {
  it('derives dirty from the saved snapshot across save, mutate, undo, and redo', async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    const document = initializedDocument();
    await document.save();
    expect(document.isDirty).toBe(false);
    document.mutate('Place blocker', (sector) => {
      sector.blockers.push(blocker('wall'));
    });
    expect(document.isDirty).toBe(true);
    // Undo back to the savepoint must read as clean again — a boolean flag cannot do this.
    document.undo();
    expect(document.isDirty).toBe(false);
    document.redo();
    expect(document.isDirty).toBe(true);
  });

  it('reports an uninitialized document as clean and a created one as dirty', () => {
    const document = new EditorDocument();
    expect(document.isUninitialized).toBe(true);
    expect(document.isDirty).toBe(false);
    expect(document.create({ ...SETTINGS, name: 'Fresh', kind: 'interior', width: 5, depth: 4, brightness: 60 })).toEqual({ accepted: true });
    expect(document.isUninitialized).toBe(false);
    expect(document.isDirty).toBe(true);
    expect(document.sector).toEqual({
      name: 'Fresh',
      kind: 'interior',
      brightness: 60,
      size: { width: 5, depth: 4 },
      floorMaterialId: 'grass-meadow',
      floorPatches: [],
      placements: [],
      blockers: [],
      doors: [],
      npcs: [],
      monsterSpawns: [],
    });
  });
});

describe('sector settings', () => {
  it('reads back what it wrote, for either kind', () => {
    const document = initializedDocument();
    const outdoor = { ...SETTINGS, originX: 5.12, originZ: -30.72, width: 30.72 };
    const interior = { ...SETTINGS, kind: 'interior' as const, brightness: 70 };
    for (const settings of [outdoor, interior]) {
      document.mutate('Edit sector settings', (sector) => applySectorSettings(sector, settings));
      expect(sectorSettings(document.sector)).toEqual(settings);
    }
  });

  it('never leaves an origin on an interior or a brightness on an outdoor sector', () => {
    const document = initializedDocument();
    document.mutate('To interior', (sector) => applySectorSettings(sector, { ...SETTINGS, kind: 'interior', brightness: 70 }));
    expect(document.sector.origin).toBeUndefined();
    expect(document.sector.brightness).toBe(70);
    document.mutate('To outdoor', (sector) => applySectorSettings(sector, { ...SETTINGS, originX: 3 }));
    expect(document.sector.origin).toEqual({ x: 3, z: 0 });
    expect(document.sector.brightness).toBeUndefined();
  });
});

describe('file API round trips', () => {
  it('load resets history and checkpoint', async () => {
    stubFetch(() => new Response(readSectorFixture('EdariaArena'), { status: 200 }));
    const document = initializedDocument();
    await document.load('EdariaArena');
    expect(document.sector.name).toBe('EdariaArena');
    expect(document.sector.kind).toBe('interior');
    expect(document.isDirty).toBe(false);
    expect(document.canUndo).toBe(false);
  });

  it('save PUTs the serialized sector under its own name', async () => {
    const puts: { url: string; body: string }[] = [];
    stubFetch((url, init) => {
      if (init?.method === 'PUT') {
        puts.push({ url, body: typeof init.body === 'string' ? init.body : '' });
        return new Response(null, { status: 204 });
      }
      return new Response(readSectorFixture('EdariaMitte'), { status: 200 });
    });
    const document = new EditorDocument();
    await document.load('EdariaMitte');
    await document.save();
    expect(puts.length).toBe(1);
    expect(puts[0]?.url).toContain('/__editor/sectors/EdariaMitte');
    // An unedited save writes the exact committed bytes — the codec check under real use.
    expect(puts[0]?.body).toBe(readSectorFixture('EdariaMitte'));
  });

  it('saveAs writes the new name and leaves the original in place', async () => {
    const puts: string[] = [];
    stubFetch((url, init) => {
      if (init?.method === 'PUT') {
        puts.push(url);
        return new Response(null, { status: 204 });
      }
      return new Response(readSectorFixture('EdariaArena'), { status: 200 });
    });
    const document = new EditorDocument();
    await document.load('EdariaArena');
    await document.saveAs('ArenaCopy');
    expect(document.sector.name).toBe('ArenaCopy');
    expect(puts).toEqual([`/__editor/sectors/${encodeURIComponent('ArenaCopy')}`]);
  });

  it('keeps the checkpoint when a save fails', async () => {
    stubFetch(() => new Response('boom', { status: 500 }));
    const document = initializedDocument();
    await expect(document.save()).rejects.toThrow(/saving/);
    expect(document.isDirty).toBe(true);
  });

  it('stays dirty when an edit lands during the save PUT', async () => {
    const document = new EditorDocument();
    stubFetch((_url, init) => {
      if (init?.method === 'PUT') {
        // Editing stays enabled during the await; this edit is not in the body being written.
        document.mutate('edit during save', (sector) => {
          sector.brightness = 50;
        });
        return new Response(null, { status: 204 });
      }
      return new Response(readSectorFixture('EdariaArena'), { status: 200 });
    });
    await document.load('EdariaArena');
    await document.save();
    // The checkpoint is the snapshot that was PUT, not the mid-flight edit — so it reads dirty.
    expect(document.isDirty).toBe(true);
  });

  it('rolls the name back when Save As fails to write', async () => {
    stubFetch((_url, init) => {
      if (init?.method === 'PUT') return new Response('boom', { status: 500 });
      return new Response(readSectorFixture('EdariaArena'), { status: 200 });
    });
    const document = new EditorDocument();
    await document.load('EdariaArena');
    await expect(document.saveAs('ArenaCopy')).rejects.toThrow(/saving/);
    // The rename bypasses `commit`, so a failed write must restore the name by hand.
    expect(document.sector.name).toBe('EdariaArena');
  });
});

describe('preferences', () => {
  it('quantizes to the nearest step, to the millimetre, with a free-step identity', () => {
    expect(quantize(1.3, 0.5)).toBe(1.5);
    expect(quantize(1.2, 0.5)).toBe(1);
    expect(quantize(0.3, 0.1)).toBe(0.3);
    expect(quantize(5.12 + 30.72, 0.25)).toBe(35.75);
    expect(quantize(-1.3, 0.5)).toBe(-1.5);
    expect(quantize(-0.1, 1)).toBe(0);
    expect(quantize(1.23456, 0)).toBe(1.235);
    expect(quantize(5.12 + 30.72, 0)).toBe(35.84);
  });

  it('falls back from a free grid to the fine step', () => {
    expect(stepOrFine(0.25)).toBe(0.25);
    expect(stepOrFine(0)).toBe(0.01);
  });

  it('falls back to the default for an absent key, never to free', () => {
    // `free` is stored as `0`, so the absent-vs-zero distinction is the whole point.
    const empty = new Map<string, string>();
    const storage = {
      getItem: (key: string) => empty.get(key) ?? null,
      setItem: (key: string, value: string) => void empty.set(key, value),
    };
    expect(currentGridSnap(storage)).toBe(DEFAULT_GRID_SNAP);
    persistGridSnap(0, storage);
    expect(currentGridSnap(storage)).toBe(0);
    persistGridSnap(0.25, storage);
    expect(currentGridSnap(storage)).toBe(0.25);
    expect([...empty.keys()]).toEqual(['somnio.editor.gridSnap']);
  });

  it('falls back to the default for a stored value that is not a preset', () => {
    expect(currentGridSnap({ getItem: () => '32' })).toBe(DEFAULT_GRID_SNAP);
  });

  it('pins the grid-snap presets to their documented literals', () => {
    // A runtime pin, not a self-referential one: `as const` only pins the derived type, so a raw
    // value edit would pass a type-shaped assertion.
    expect([...GRID_SNAP_PRESETS]).toEqual([1, 0.5, 0.25, 0.1, 0]);
    expect(DEFAULT_GRID_SNAP).toBe(0.5);
  });

  it('keeps the session grid-snap when the store write throws', () => {
    // The production path (no explicit storage arg) reads/writes real `localStorage`; stub it to
    // throw on write and confirm the selection survives in memory rather than snapping back.
    const original = globalThis.localStorage;
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    Object.defineProperty(globalThis, 'localStorage', { value: throwing, configurable: true });
    try {
      persistGridSnap(0.1);
      expect(currentGridSnap()).toBe(0.1);
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true });
    }
  });
});
