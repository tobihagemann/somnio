import * as THREE from 'three';
import { onTestFinished, vi } from 'vitest';
import type { Point, Sector } from '@somnio/core';
import type { SectorSettings } from '@/editor/document';
import type { DragContext } from '@/editor/drag/geometry';
import { EditorShell } from '@/editor/editorShell';
import { applyFramingToCamera, editorFramingFittingBounds } from '@/editor/framing';
import type { ViewportSize } from '@/editor/picking';
import { TEST_REGISTRY, outdoorSector } from '../../../core/test/support/worldFixture.ts';

/** A 20 m outdoor sector at the origin of its space, on a floor the bundled registry maps. */
export const SETTINGS: SectorSettings = {
  name: 'Test',
  kind: 'outdoor',
  width: 20,
  depth: 20,
  originX: 0,
  originZ: 0,
  brightness: 100,
  floorMaterialId: 'grass-meadow',
};

export const VIEWPORT: ViewportSize = { width: 640, height: 480 };

/** The sector `SETTINGS` names, with no content, over the test registry's floor. */
export function emptySector(overrides: Partial<Sector> = {}): Sector {
  return outdoorSector('Test', { x: 0, z: 0 }, overrides);
}

/** A drag over the test registry, seen by a camera that frames the 20 m square at `origin`. */
export function dragContext(gridStep = 0.5, origin: Point = { x: 0, z: 0 }): DragContext {
  const framing = editorFramingFittingBounds(origin, { x: origin.x + 20, z: origin.z + 20 }, VIEWPORT);
  const camera = new THREE.OrthographicCamera();
  applyFramingToCamera(camera, framing, VIEWPORT);
  return { camera, viewport: VIEWPORT, origin, gridStep, registry: TEST_REGISTRY };
}

/**
 * Makes happy-dom blur a focused element that is about to be removed, while it is still in the
 * tree, as Chromium does. Left alone, happy-dom fires no `blur` on removal, as Firefox and Safari
 * do not. Lasts until the test that called it has finished.
 */
export function blurOnRemoval(): void {
  const original = Object.getOwnPropertyDescriptor(Element.prototype, 'replaceChildren')!.value as (this: Element, ...nodes: (Node | string)[]) => void;
  const spy = vi.spyOn(Element.prototype, 'replaceChildren').mockImplementation(function (this: Element, ...nodes: (Node | string)[]) {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused !== this && this.contains(focused)) focused.blur();
    original.apply(this, nodes);
  });
  onTestFinished(() => spy.mockRestore());
}

/** The control a label names, inside `root`. */
export function labelled(root: HTMLElement, label: string): HTMLInputElement {
  const node = [...root.querySelectorAll('label')].find((candidate) => candidate.textContent === label)!;
  return document.getElementById(node.getAttribute('for')!) as HTMLInputElement;
}

/** A file API holding no sectors. */
export function stubEmptySectorAPI(): void {
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify([]), { status: 200 })));
}

/** An `EditorShell` with no renderer, on the sector picker it opens with. */
export function headlessShell(): EditorShell {
  const container = document.createElement('div');
  document.body.append(container);
  return new EditorShell({ container, startRendering: false });
}

/** A headless shell editing a fresh sector on the canvas, over a file API that holds no other. */
export function shellWithDocument(settings: SectorSettings = SETTINGS): EditorShell {
  stubEmptySectorAPI();
  const shell = headlessShell();
  shell.document.create(settings);
  shell.present(undefined);
  return shell;
}
