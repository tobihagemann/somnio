import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Point } from '@somnio/core';
import type { EditorShell } from '@/editor/editorShell';
import { screenAtFloorPoint } from '@/editor/picking';
import { replaceChildren } from '@/ui/dom';
import { SETTINGS, blurOnRemoval, labelled, shellWithDocument } from './helpers/editorFixture';

/**
 * The pointer pipeline through a headless `EditorShell`: real pointer events on the canvas, in
 * the order a browser delivers them, down to the document, the selection, the live scene nodes,
 * and the error banner.
 */

/** Fires a pointer event at the viewport point a ground point of the document's space projects to. */
function pointer(shell: EditorShell, type: string, at: Point, init: PointerEventInit = {}): void {
  const origin = shell.document.sector.origin ?? { x: 0, z: 0 };
  const screen = screenAtFloorPoint(shell.scene.camera, shell.camera.viewportSize, { x: origin.x + at.x, z: origin.z + at.z });
  const canvas = document.querySelector('#somnio-editor-canvas')!;
  canvas.dispatchEvent(new PointerEvent(type, { clientX: screen.x, clientY: screen.y, button: 0, pointerId: 1, bubbles: true, ...init }));
}

function click(shell: EditorShell, at: Point, init: PointerEventInit = {}): void {
  pointer(shell, 'pointerdown', at, init);
  pointer(shell, 'pointerup', at, init);
}

function drag(shell: EditorShell, from: Point, to: Point): void {
  pointer(shell, 'pointerdown', from);
  pointer(shell, 'pointermove', to);
  pointer(shell, 'pointerup', to);
}

function banner(): HTMLElement {
  return document.querySelector<HTMLElement>('.editor-error-banner')!;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('placing', () => {
  it('places a model on a click, with no blocker, and selects it', () => {
    const shell = shellWithDocument();
    shell.tool = 'placement';
    const depth = shell.document.undoDepth;
    click(shell, { x: 6.1, z: 7.9 });
    const [placed] = shell.document.sector.placements;
    expect(shell.document.sector.placements.length).toBe(1);
    // Snapped to the default half-metre grid.
    expect(placed).toMatchObject({ x: 6, z: 8, yaw: 0, elevation: 0 });
    expect(placed?.id).toBe(`${placed?.modelId}-1`);
    expect(shell.recordCounts()).toEqual({ placements: 1, blockers: 0, doors: 0, npcs: 0, monsterSpawns: 0, floorPatches: 0 });
    expect(shell.selection).toEqual([{ kind: 'placement', id: placed?.id }]);
    expect(shell.document.undoDepth).toBe(depth + 1);
  });

  it('stamps the model of the placement selected last', () => {
    const shell = shellWithDocument();
    shell.document.mutate('Seed', (sector) => {
      sector.placements.push({ id: 'building-house-1', modelId: 'building-house', x: 5, z: 5, yaw: 0, elevation: 0 });
    });
    click(shell, { x: 5, z: 5 });
    expect(shell.selection).toEqual([{ kind: 'placement', id: 'building-house-1' }]);
    shell.tool = 'placement';
    click(shell, { x: 14, z: 14 });
    expect(shell.document.sector.placements[1]).toMatchObject({ id: 'building-house-2', modelId: 'building-house', x: 14, z: 14 });
    expect(shell.document.sector.blockers).toEqual([]);
  });

  it('rubber-bands a rect tool from press to release', () => {
    const shell = shellWithDocument();
    shell.tool = 'blocker';
    drag(shell, { x: 2, z: 2 }, { x: 5, z: 3.5 });
    expect(shell.document.sector.blockers).toEqual([{ id: 'blocker-1', x: 2, z: 2, width: 3, depth: 1.5 }]);
  });

  it('places into a sector that stands away from the origin of its space', () => {
    const shell = shellWithDocument({ ...SETTINGS, originX: 5.12, originZ: -30.72 });
    shell.tool = 'npc';
    click(shell, { x: 3, z: 4 });
    expect(shell.document.sector.npcs[0]).toMatchObject({ id: 'npc-1', x: 3, z: 4 });
  });

  it('shows what the document refuses in the banner and places nothing', () => {
    const shell = shellWithDocument();
    shell.tool = 'floorPatch';
    click(shell, { x: 2, z: 2 });
    const depth = shell.document.undoDepth;
    click(shell, { x: 2.5, z: 2.5 });
    expect(shell.document.sector.floorPatches.length).toBe(1);
    expect(shell.document.undoDepth).toBe(depth);
    expect(shell.selection).toEqual([{ kind: 'floorPatch', id: 'patch-1' }]);
    expect(banner().textContent).toBe('Floor patches must not overlap.');
    expect(banner().classList.contains('hidden')).toBe(false);
  });
});

function withBarrel(): EditorShell {
  const shell = shellWithDocument();
  shell.document.mutate('Seed', (sector) => {
    sector.placements.push({ id: 'barrel-1', modelId: 'barrel', x: 5, z: 5, yaw: 0, elevation: 0 });
    sector.blockers.push({ id: 'blocker-1', x: 3, z: 3, width: 4, depth: 4 });
  });
  return shell;
}

describe('selecting and dragging', () => {
  it('selects the prop under the first click, not the blocker beneath it', () => {
    const shell = withBarrel();
    const depth = shell.document.undoDepth;
    click(shell, { x: 5, z: 5 });
    expect(shell.selection).toEqual([{ kind: 'placement', id: 'barrel-1' }]);
    expect(shell.document.undoDepth).toBe(depth);
    click(shell, { x: 6.5, z: 6.5 });
    expect(shell.selection).toEqual([{ kind: 'blocker', id: 'blocker-1' }]);
    click(shell, { x: 15, z: 15 });
    expect(shell.selection).toEqual([]);
  });

  it('moves the live node while dragging and commits once on release', () => {
    const shell = withBarrel();
    const depth = shell.document.undoDepth;
    pointer(shell, 'pointerdown', { x: 5, z: 5 });
    pointer(shell, 'pointermove', { x: 8, z: 6.5 });
    const node = shell.scene.placementNode('Test', 'barrel-1')!;
    expect([node.position.x, node.position.z]).toEqual([8, 6.5]);
    // Nothing is committed while the pointer is down.
    expect(shell.document.sector.placements[0]).toMatchObject({ x: 5, z: 5 });
    expect(shell.document.undoDepth).toBe(depth);
    pointer(shell, 'pointerup', { x: 8, z: 6.5 });
    expect(shell.document.sector.placements[0]).toMatchObject({ x: 8, z: 6.5 });
    expect(shell.document.undoDepth).toBe(depth + 1);
    expect(shell.selection).toEqual([{ kind: 'placement', id: 'barrel-1' }]);
  });

  it('puts the live node back when a drag returns to its start', () => {
    const shell = withBarrel();
    const depth = shell.document.undoDepth;
    pointer(shell, 'pointerdown', { x: 5, z: 5 });
    pointer(shell, 'pointermove', { x: 9, z: 9 });
    const node = shell.scene.placementNode('Test', 'barrel-1')!;
    pointer(shell, 'pointerup', { x: 5, z: 5 });
    expect([node.position.x, node.position.z]).toEqual([5, 5]);
    expect(shell.document.undoDepth).toBe(depth);
  });

  it('abandons a cancelled drag: the node goes back and a later move does not resume it', () => {
    const shell = withBarrel();
    const depth = shell.document.undoDepth;
    pointer(shell, 'pointerdown', { x: 5, z: 5 });
    pointer(shell, 'pointermove', { x: 9, z: 9 });
    const node = shell.scene.placementNode('Test', 'barrel-1')!;
    pointer(shell, 'pointercancel', { x: 9, z: 9 });
    expect([node.position.x, node.position.z]).toEqual([5, 5]);
    pointer(shell, 'pointermove', { x: 12, z: 12 });
    pointer(shell, 'pointerup', { x: 12, z: 12 });
    expect(shell.document.sector.placements[0]).toMatchObject({ x: 5, z: 5 });
    expect(shell.document.undoDepth).toBe(depth);
  });

  it('draws a marquee over empty ground and selects what it crosses', () => {
    const shell = withBarrel();
    const marquee = document.querySelector<HTMLElement>('.editor-marquee')!;
    pointer(shell, 'pointerdown', { x: 1, z: 9 });
    pointer(shell, 'pointermove', { x: 9, z: 1 });
    expect(marquee.classList.contains('hidden')).toBe(false);
    pointer(shell, 'pointerup', { x: 9, z: 1 });
    expect(marquee.classList.contains('hidden')).toBe(true);
    expect(shell.selection).toEqual([
      { kind: 'placement', id: 'barrel-1' },
      { kind: 'blocker', id: 'blocker-1' },
    ]);
  });

  it('adds to the selection on a shift-click', () => {
    const shell = withBarrel();
    click(shell, { x: 5, z: 5 });
    click(shell, { x: 6.5, z: 6.5 }, { shiftKey: true });
    expect(shell.selection).toEqual([
      { kind: 'placement', id: 'barrel-1' },
      { kind: 'blocker', id: 'blocker-1' },
    ]);
  });

  it('ignores the canvas under an overlay and for any button but the primary', () => {
    const shell = withBarrel();
    click(shell, { x: 5, z: 5 }, { button: 2 });
    expect(shell.selection).toEqual([]);
    shell.present('gameMenu');
    click(shell, { x: 5, z: 5 });
    expect(shell.selection).toEqual([]);
  });
});

describe('a draft being typed into an inspector field', () => {
  /** The blocker selected by a click, and a width typed into its inspector field but not committed. */
  function typing(text: string): { shell: EditorShell; field: HTMLInputElement } {
    const shell = withBarrel();
    click(shell, { x: 6.5, z: 6.5 });
    const field = labelled(shell.inspector.root, 'Width');
    field.focus();
    field.value = text;
    return { shell, field };
  }

  const gestures = [
    ['a click on another record', (shell: EditorShell) => click(shell, { x: 5, z: 5 }), [{ kind: 'placement', id: 'barrel-1' }]],
    ['Escape', (shell: EditorShell) => shell.handleEscape(), []],
  ] as const;
  // The engine that blurs comes first, so a double that outlived its test would show in the other.
  const engines = [
    ['blurs an input it removes', true],
    ['fires no blur on removal', false],
  ] as const;
  const cases = gestures.flatMap(([gesture, perform, selection]) =>
    engines.map(([engine, blursOnRemoval]) => [gesture, engine, perform, selection, blursOnRemoval] as const),
  );

  it.each(cases)('is committed once before %s, where the engine %s', (_gesture, _engine, perform, selection, blursOnRemoval) => {
    if (blursOnRemoval) blurOnRemoval();
    const { shell, field } = typing('6');
    const mutate = vi.spyOn(shell.document, 'mutate');
    const depth = shell.document.undoDepth;
    expect(document.activeElement).toBe(field);
    perform(shell);
    expect(field.isConnected).toBe(false);
    expect(shell.document.sector.blockers[0]?.width).toBe(6);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(shell.document.undoDepth).toBe(depth + 1);
    expect(shell.selection).toEqual(selection);
  });

  const drags = [
    {
      target: 'another record',
      records: 'placements',
      from: { x: 5, z: 5 },
      to: { x: 8, z: 6.5 },
      start: { x: 5, z: 5 },
      end: { x: 8, z: 6.5 },
      selected: { kind: 'placement', id: 'barrel-1' },
    },
    {
      target: 'the record it belongs to',
      records: 'blockers',
      from: { x: 6.5, z: 6.5 },
      to: { x: 8.5, z: 7.5 },
      start: { x: 3, z: 3 },
      end: { x: 5, z: 4 },
      selected: { kind: 'blocker', id: 'blocker-1' },
    },
  ] as const;
  const dragCases = drags.flatMap((gesture) => engines.map(([engine, blursOnRemoval]) => ({ ...gesture, engine, blursOnRemoval })));

  it.each(dragCases)(
    'is committed as a step of its own before a press that drags $target, where the engine $engine',
    ({ records, from, to, start, end, selected, blursOnRemoval }) => {
      if (blursOnRemoval) blurOnRemoval();
      const { shell } = typing('6');
      const depth = shell.document.undoDepth;
      const state = (): unknown => {
        const record = shell.document.sector[records][0]!;
        return { width: shell.document.sector.blockers[0]?.width, at: { x: record.x, z: record.z } };
      };
      drag(shell, from, to);
      expect(state()).toEqual({ width: 6, at: end });
      expect(shell.document.undoDepth).toBe(depth + 2);
      expect(shell.selection).toEqual([selected]);
      shell.undo();
      expect(state()).toEqual({ width: 6, at: start });
      shell.undo();
      expect(state()).toEqual({ width: 4, at: start });
    },
  );

  it.each(engines)('rests on an engine that %s when the row replacement removes a focused input', (_engine, blursOnRemoval) => {
    if (blursOnRemoval) blurOnRemoval();
    const input = document.createElement('input');
    const rows = document.createElement('div');
    rows.append(input);
    document.body.append(rows);
    input.focus();
    const connected: boolean[] = [];
    input.addEventListener('blur', () => connected.push(input.isConnected));
    replaceChildren(rows, []);
    // Blurred while still in the tree, or not at all.
    expect(connected).toEqual(blursOnRemoval ? [true] : []);
    expect(input.isConnected).toBe(false);
  });

  it('keeps the focus in a field whose commit leaves the selection as it was', () => {
    const { shell, field } = typing('6');
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    expect(shell.document.sector.blockers[0]?.width).toBe(6);
    expect(document.activeElement).toBe(field);
  });

  it('is shown in the banner when the document refuses it, and the selection changes all the same', () => {
    const { shell, field } = typing('0');
    const before = structuredClone(shell.document.sector);
    const depth = shell.document.undoDepth;
    click(shell, { x: 5, z: 5 });
    expect(banner().classList.contains('hidden')).toBe(false);
    expect(banner().textContent).toContain('width');
    expect(shell.document.sector).toEqual(before);
    expect(shell.document.undoDepth).toBe(depth);
    expect(field.isConnected).toBe(false);
    expect(shell.selection).toEqual([{ kind: 'placement', id: 'barrel-1' }]);
  });
});

describe('hover', () => {
  it('reads out the hovered ground point and keeps it as the paste anchor after the pointer leaves', () => {
    const shell = shellWithDocument();
    pointer(shell, 'pointermove', { x: 4.25, z: 7.5 });
    expect([shell.readout.x, shell.readout.z]).toEqual([4.25, 7.5]);
    document.querySelector('#somnio-editor-canvas')!.dispatchEvent(new PointerEvent('pointerleave'));
    expect([shell.readout.x, shell.readout.z]).toEqual([0, 0]);
    expect(shell.lastHoveredGrid).toEqual({ x: 4.25, z: 7.5 });
  });
});
