import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseModelRegistry, resolveDoor } from '@somnio/core';
import type { ModelRegistry, Sector, WorldIssue } from '@somnio/core';
import { AuthoringOverlay, overlayLabels } from '@/editor/authoringOverlay';
import type { AuthoringOverlayInput } from '@/editor/authoringOverlay';
import type { EditorShell } from '@/editor/editorShell';
import { selectionFootprint } from '@/editor/selection';
import { TEST_REGISTRY } from '../../core/test/support/worldFixture.ts';
import { SETTINGS, emptySector, headlessShell, stubEmptySectorAPI } from './helpers/editorFixture';

/**
 * The authoring overlay (what it draws for each record and where, the issue colour, the labels,
 * the grid-line cap, the zero-extent guard) and the Esc state table — the latter through a
 * headless `EditorShell`, which also smoke-tests the whole composition without a renderer.
 */

const RED = 0xff0000;
const ANCHOR = 0xffa000;

function input(body: Sector, overrides: Partial<AuthoringOverlayInput> = {}): AuthoringOverlayInput {
  return { sector: body, registry: TEST_REGISTRY, issues: [], selection: [], showGrid: false, gridStep: 0.5, ...overrides };
}

function meshes(root: THREE.Object3D): THREE.Mesh[] {
  const found: THREE.Mesh[] = [];
  root.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) found.push(object as THREE.Mesh);
  });
  return found;
}

function colors(root: THREE.Object3D): number[] {
  return meshes(root).map((mesh) => (mesh.material as THREE.MeshBasicMaterial).color.getHex());
}

/** Where a mesh's center lies, relative to the overlay root. */
function centerOf(mesh: THREE.Mesh, overlay: AuthoringOverlay): THREE.Vector3 {
  overlay.root.updateMatrixWorld(true);
  return overlay.root.worldToLocal(mesh.getWorldPosition(new THREE.Vector3()));
}

/** A registry holding one object model, for the geometry the shared test registry has no model for. */
function registryWith(objectModel: object): ModelRegistry {
  return parseModelRegistry({
    characterModels: [{ id: 'hero', model: { stem: 'Hero', expectedClips: ['Idle'] } }],
    playerModel: 'hero',
    floorMaterials: [{ id: 'grass', stem: 'Grass' }],
    objectModels: [objectModel],
  });
}

const door = { id: 'exit', placement: 'door-1', anchor: 'main', target: { sector: 'Mitte', door: 'to-test' } };
const doorPlacement = { id: 'door-1', modelId: 'door', x: 10, z: 19, yaw: 0, elevation: 0 };

describe('AuthoringOverlay', () => {
  it('draws one gizmo per record that means something on the ground, rebuilt from scratch each update', () => {
    const overlay = new AuthoringOverlay();
    const body = emptySector({
      floorPatches: [{ id: 'patch-1', floorMaterialId: 'cobble', x: 0, z: 12, width: 4, depth: 4 }],
      blockers: [{ id: 'blocker-1', x: 0, z: 0, width: 2, depth: 1 }],
      placements: [
        { id: 'box-1', modelId: 'box', x: 6, z: 6, yaw: 0, elevation: 0 },
        { id: 'rug-1', modelId: 'rug', x: 9, z: 6, yaw: 0, elevation: 0 },
        doorPlacement,
      ],
      doors: [door],
      npcs: [{ id: 'libus', name: 'Libus', characterModelId: 'hero', x: 3, z: 9, facing: 0, dialogScript: '' }],
      monsterSpawns: [{ id: 'spawn-1', kind: 'gespenst', x: 12, z: 12, width: 4, depth: 4, maxAlive: 3 }],
      spawn: { x: 5, z: 15, facing: 0 },
    });
    const selection = [selectionFootprint({ kind: 'blocker', id: 'blocker-1' }, body, TEST_REGISTRY)!];
    overlay.update(input(body, { selection }));
    // Patch, blocker, the box's collider, the door model's anchor, the door's trigger and
    // arrival, the spawn area, the NPC, the spawn point, and the selection border. The rug
    // neither blocks nor carries nor takes a door, so it draws nothing.
    expect(overlay._childCount()).toBe(9);

    overlay.update(input(body));
    expect(overlay._childCount()).toBe(8);
  });

  it('stands at the sector origin, so records draw at their sector-relative positions', () => {
    const overlay = new AuthoringOverlay();
    const body = emptySector({ origin: { x: 5.12, z: -30.72 }, blockers: [{ id: 'blocker-1', x: 2, z: 4, width: 2, depth: 1 }] });
    overlay.update(input(body));
    expect(overlay.root.position.toArray()).toEqual([5.12, 0, -30.72]);
    const center = centerOf(meshes(overlay.root)[0]!, overlay);
    expect(center.x).toBeCloseTo(3, 9);
    expect(center.z).toBeCloseTo(4.5, 9);
  });

  it("draws a placement's colliders, walk surfaces at their height, and ledges, turned with it", () => {
    const registry = registryWith({
      id: 'porch',
      model: { stem: 'Porch', expectedClips: [] },
      footprint: { width: 4, depth: 2 },
      colliders: [{ x: -2, z: -1, width: 2, depth: 2 }],
      walkSurfaces: [{ x: 0, z: -1, width: 2, depth: 2, height: 0.6 }],
    });
    const overlay = new AuthoringOverlay();
    overlay.update(input(emptySector({ placements: [{ id: 'porch-1', modelId: 'porch', x: 10, z: 10, yaw: 90, elevation: 0 }] }), { registry }));
    const gizmo = overlay.root.children[0]!;
    expect(gizmo.rotation.y).toBeCloseTo(Math.PI / 2, 9);
    // One collider, one surface, and a ledge along each of the surface's four edges: the step
    // down to the floor is higher than a body takes.
    const parts = meshes(gizmo);
    expect(parts.length).toBe(6);
    const [collider, surface, ...ledges] = parts.map((mesh) => centerOf(mesh, overlay));
    // At yaw 90 the model's +X points north: the collider, at model x -1, lies south of the origin.
    expect(collider!.x).toBeCloseTo(10, 9);
    expect(collider!.z).toBeCloseTo(11, 9);
    expect(collider!.y).toBe(0);
    expect(surface!.z).toBeCloseTo(9, 9);
    expect(surface!.y).toBeCloseTo(0.6, 9);
    expect(ledges.map((ledge) => ledge.y)).toEqual([0.6, 0.6, 0.6, 0.6]);
    const lengths = parts.slice(2).map((mesh) => (mesh.geometry as THREE.PlaneGeometry).parameters.height);
    expect(lengths).toEqual([2, 2, 2, 2]);
  });

  it('draws a door trigger in front of its anchor and the arrival point beyond it', () => {
    const overlay = new AuthoringOverlay();
    const body = emptySector({ origin: { x: 100, z: 50 }, placements: [doorPlacement], doors: [door] });
    overlay.update(input(body));
    // The placement's own gizmo comes first; the door record's is the second child.
    const parts = meshes(overlay.root.children[1]!);
    const [trigger, arrival] = parts.map((mesh) => centerOf(mesh, overlay));
    const resolved = resolveDoor(body, door, TEST_REGISTRY)!;
    // The test door opens toward -Z: the trigger covers the 0.58 m north of the door, 1.54 m wide.
    expect(trigger!.x).toBeCloseTo(10, 9);
    expect(trigger!.z).toBeCloseTo(18.71, 9);
    expect((parts[0]!.geometry as THREE.PlaneGeometry).parameters).toMatchObject({ width: 1.54, height: 0.58 });
    expect(arrival!.x).toBeCloseTo(resolved.arrival.x - 100, 9);
    expect(arrival!.z).toBeCloseTo(resolved.arrival.z - 50, 9);
    expect(arrival!.z).toBeCloseTo(18.2, 9);
    // The test door stands on the floor, and so does everything about it.
    expect(meshes(overlay.root).map((mesh) => centerOf(mesh, overlay).y)).toEqual([0, 0, 0, 0]);
  });

  it('draws a door anchor, its trigger, and its arrival point at the height of the ground under each', () => {
    // A door at the top of a stair: the wall at model x 0, a landing 0.7 m deep at 1 m, and a
    // tread below it at 0.75 m, which is where 0.8 m out from the wall falls.
    const registry = registryWith({
      id: 'house',
      model: { stem: 'House', expectedClips: [] },
      footprint: { width: 4, depth: 2 },
      colliders: [{ x: -2, z: -1, width: 2, depth: 2 }],
      walkSurfaces: [
        { x: 0, z: -1, width: 0.7, depth: 2, height: 1 },
        { x: 0.7, z: -1, width: 0.5, depth: 2, height: 0.75 },
      ],
      doors: [{ id: 'main', x: 0, z: 0, facing: 90, width: 1 }],
    });
    const body = emptySector({
      origin: { x: 100, z: 50 },
      placements: [{ id: 'house-1', modelId: 'house', x: 10, z: 10, yaw: 90, elevation: 0 }],
      doors: [{ id: 'in', placement: 'house-1', anchor: 'main', target: { sector: 'Hall', door: 'exit' } }],
    });
    const overlay = new AuthoringOverlay();
    overlay.update(input(body, { registry }));
    const [placementGizmo, doorGizmo] = overlay.root.children;
    const anchor = meshes(placementGizmo!).filter((mesh) => (mesh.material as THREE.MeshBasicMaterial).color.getHex() === ANCHOR);
    expect(anchor.map((mesh) => centerOf(mesh, overlay).y)).toEqual([1, 1]);
    const [trigger, arrival] = meshes(doorGizmo!).map((mesh) => centerOf(mesh, overlay));
    expect(trigger!.y).toBe(1);
    expect(arrival!.y).toBe(0.75);
    // At yaw 90 the door opens north: the arrival point is 0.8 m north of the wall.
    expect(arrival!.x).toBeCloseTo(10, 9);
    expect(arrival!.z).toBeCloseTo(9.2, 9);
  });

  it('draws what the world reports in red, and only that', () => {
    const body = emptySector({
      placements: [
        { id: 'dais-1', modelId: 'dais', x: 4, z: 4, yaw: 0, elevation: 0 },
        { id: 'odd-1', modelId: 'odd', x: 8, z: 8, yaw: 0, elevation: 0 },
        doorPlacement,
      ],
      doors: [door],
    });
    const overlay = new AuthoringOverlay();
    overlay.update(input(body));
    // The model the registry does not know is an issue by itself.
    expect(colors(overlay.root).filter((color) => color === RED).length).toBe(1);

    const issues: WorldIssue[] = [
      { sector: 'Test', record: 'placement', id: 'dais-1', message: 'walk surfaces overlap' },
      { sector: 'Test', record: 'door', id: 'exit', message: 'target door does not exist' },
    ];
    overlay.update(input(body, { issues }));
    // The door model's anchor is registry data, not a record the world reports on.
    expect(colors(overlay.root)).toEqual([RED, RED, ANCHOR, ANCHOR, RED, RED]);
  });

  it('marks every door anchor of a placement model on its wall, turned with the placement, with or without a door record', () => {
    const overlay = new AuthoringOverlay();
    const turnedDoor = { ...doorPlacement, yaw: 90 };
    overlay.update(input(emptySector({ placements: [turnedDoor] })));
    // No door record uses the anchor, so the marker is all there is: no trigger, no arrival.
    expect(overlay._childCount()).toBe(1);
    const [line, tick] = meshes(overlay.root);
    expect(colors(overlay.root)).toEqual([ANCHOR, ANCHOR]);
    // The test door is 1.54 m wide along model X and opens toward -Z. At yaw 90 model X runs
    // north, so the line across the opening runs north-south through the anchor and the tick
    // points west.
    overlay.root.updateMatrixWorld(true);
    const ends = [-0.77, 0.77].map((along) => line!.localToWorld(new THREE.Vector3(0, along, 0)));
    expect(ends.map((end) => end.x)).toEqual([expect.closeTo(10, 9), expect.closeTo(10, 9)]);
    expect(ends.map((end) => end.z).sort()).toEqual([expect.closeTo(18.23, 9), expect.closeTo(19.77, 9)]);
    const pointing = centerOf(tick!, overlay);
    expect(pointing.x).toBeLessThan(10);
    expect(pointing.z).toBeCloseTo(19, 9);

    // A door record on the anchor adds its trigger and arrival; the anchor marker stays.
    overlay.update(input(emptySector({ placements: [turnedDoor], doors: [door] })));
    expect(overlay._childCount()).toBe(2);
    expect(colors(overlay.root.children[0]!)).toEqual([ANCHOR, ANCHOR]);
  });

  it('borders a selected placement along its turned footprint, and sizes the handles it is given', () => {
    const overlay = new AuthoringOverlay();
    const body = emptySector({ placements: [{ id: 'rug-1', modelId: 'rug', x: 6, z: 6, yaw: 30, elevation: 0 }] });
    overlay.update(
      input(body, {
        selection: [selectionFootprint({ kind: 'placement', id: 'rug-1' }, body, TEST_REGISTRY)!],
        resizeHandles: { centers: [{ x: 1, z: 2 }], extent: 0.4 },
        facingHandle: { center: { x: 6, z: 6 }, handle: { x: 9, z: 6 }, extent: 0.4 },
      }),
    );
    const [border, resize, facing] = overlay.root.children;
    expect(border!.rotation.y).toBeCloseTo(Math.PI / 6, 9);
    expect(meshes(border!).length).toBe(4);
    expect((meshes(resize!)[0]!.geometry as THREE.PlaneGeometry).parameters).toMatchObject({ width: 0.4, height: 0.4 });
    const [tether, handle] = meshes(facing!);
    expect((tether!.geometry as THREE.PlaneGeometry).parameters.height).toBe(3);
    expect(centerOf(handle!, overlay).x).toBeCloseTo(9, 9);
  });

  it('adds one grid container with a line per step across both axes', () => {
    const overlay = new AuthoringOverlay();
    const body = emptySector();
    overlay.update(input(body, { showGrid: true }));
    expect(overlay._childCount()).toBe(1);
    // A 20 m sector at the 0.5 m step: 41 lines each way.
    expect(overlay._gridLineCount()).toBe(82);
    // Counted in whole steps, so 200 decimal steps of 0.1 do not come up one line short.
    overlay.update(input(body, { showGrid: true, gridStep: 0.1 }));
    expect(overlay._gridLineCount()).toBe(402);
    overlay.update(input(body));
    expect(overlay._childCount()).toBe(0);
    expect(overlay._gridLineCount()).toBeUndefined();
  });

  it('suppresses a grid past the line cap, and a free one, instead of stalling the rebuild', () => {
    const overlay = new AuthoringOverlay();
    const body = emptySector({ size: { width: 40.96, depth: 40.96 } });
    for (const gridStep of [0.1, 0]) {
      overlay.update(input(body, { showGrid: true, gridStep }));
      expect(overlay._childCount()).toBe(0);
      expect(overlay._gridLineCount()).toBeUndefined();
    }
  });

  it('renders an empty placeholder for a zero-extent record instead of a degenerate plane', () => {
    const overlay = new AuthoringOverlay();
    overlay.update(input(emptySector({ blockers: [{ id: 'blocker-1', x: 0, z: 0, width: 0, depth: 1 }] })));
    expect(overlay._childCount()).toBe(1);
    expect(overlay.root.children[0]?.children.length).toBe(0);
  });
});

describe('overlayLabels', () => {
  const body = emptySector({
    placements: [doorPlacement],
    doors: [door],
    npcs: [
      { id: 'libus', name: 'Libus', characterModelId: 'hero', x: 3, z: 9, facing: 0, dialogScript: '' },
      { id: 'npc-2', name: '', characterModelId: 'hero', x: 4, z: 9, facing: 0, dialogScript: '' },
    ],
    monsterSpawns: [{ id: 'spawn-1', kind: 'gespenst', x: 12, z: 12, width: 4, depth: 2, maxAlive: 3 }],
  });

  it('names a door by where it leads, an NPC by its name or id, and a monster spawn by what it keeps alive', () => {
    expect(overlayLabels(body, TEST_REGISTRY, [])).toEqual([
      { text: 'exit -> Mitte/to-test', at: { x: 10, z: 19 - 0.29 }, issue: false },
      { text: 'Libus', at: { x: 3, z: 9 }, issue: false },
      { text: 'npc-2', at: { x: 4, z: 9 }, issue: false },
      { text: 'gespenst x3', at: { x: 14, z: 13 }, issue: false },
    ]);
  });

  it('marks a door the world reports, and one whose anchor its placement model lacks', () => {
    const reported = overlayLabels(body, TEST_REGISTRY, [{ sector: 'Test', record: 'door', id: 'exit', message: 'inert' }]);
    expect(reported[0]).toMatchObject({ issue: true });
    const lacking = overlayLabels({ ...body, doors: [{ ...door, anchor: 'side' }] }, TEST_REGISTRY, []);
    // With no trigger to stand in, the label falls back to the placement.
    expect(lacking[0]).toEqual({ text: 'exit -> Mitte/to-test', at: { x: 10, z: 19 }, issue: true });
    const untargeted = overlayLabels({ ...body, doors: [{ ...door, target: { sector: '', door: 'exit' } }] }, TEST_REGISTRY, []);
    expect(untargeted[0]?.text).toBe('exit -> no target sector');
  });
});

function withBlocker(shell: EditorShell): void {
  shell.document.create(SETTINGS);
  shell.document.mutate('Place blocker', (draft) => {
    draft.blockers.push({ id: 'blocker-1', x: 0, z: 0, width: 1, depth: 1 });
  });
  shell.present(undefined);
  shell.selection = [{ kind: 'blocker', id: 'blocker-1' }];
}

describe('Esc state machine', () => {
  beforeEach(() => {
    stubEmptySectorAPI();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('consumes Esc on the picker floor over an uninitialized document', () => {
    const shell = headlessShell();
    expect(shell.presentedOverlay).toBe('sectorPicker');
    shell.handleEscape();
    expect(shell.presentedOverlay).toBe('sectorPicker');
  });

  it('backs the picker and new-map overlays out to the game menu once initialized', () => {
    const shell = headlessShell();
    shell.document.create(SETTINGS);
    shell.present('sectorPicker');
    shell.handleEscape();
    expect(shell.presentedOverlay).toBe('gameMenu');
    shell.present('newMap');
    shell.handleEscape();
    expect(shell.presentedOverlay).toBe('gameMenu');
  });

  it.each(['sectorSettings', 'about', 'preferences', 'saveAs'] as const)('backs %s out to the game menu', (overlay) => {
    const shell = headlessShell();
    shell.present(overlay);
    shell.handleEscape();
    expect(shell.presentedOverlay).toBe('gameMenu');
  });

  it('dismisses the game menu back to the canvas', () => {
    const shell = headlessShell();
    shell.present('gameMenu');
    shell.handleEscape();
    expect(shell.presentedOverlay).toBeUndefined();
  });

  it('removes the selection in one undo step on delete, and no-ops under an overlay', () => {
    const shell = headlessShell();
    withBlocker(shell);
    // The modal host swallows pointer input only; the command handlers stay wired
    // underneath, so the gate must live in the shared delete path.
    shell.present('gameMenu');
    const depth = shell.document.undoDepth;
    shell.deleteSelection();
    expect(shell.document.sector.blockers.length).toBe(1);
    expect(shell.document.undoDepth).toBe(depth);
    shell.present(undefined);
    shell.deleteSelection();
    expect(shell.document.sector.blockers).toEqual([]);
    expect(shell.selection).toEqual([]);
    expect(shell.document.undoDepth).toBe(depth + 1);
  });

  it('clears a live selection before the game menu opens', () => {
    const shell = headlessShell();
    withBlocker(shell);
    shell.handleEscape();
    expect(shell.selection).toEqual([]);
    expect(shell.presentedOverlay).toBeUndefined();
    shell.handleEscape();
    expect(shell.presentedOverlay).toBe('gameMenu');
  });
});
