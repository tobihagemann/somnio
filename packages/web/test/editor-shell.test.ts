import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bundledModelRegistry, readSectorFile } from '@somnio/core';
import type { Sector } from '@somnio/core';
import { installEditorDebugAPI } from '@/editor/debugApi';
import type { EditorShell } from '@/editor/editorShell';
import { screenAtFloorPoint } from '@/editor/picking';
import { SUN_SHADOW } from '@/scene/dayNightSun';
import { documentIssues, issueMessages, neighbours } from '@/editor/surroundings';
import { SECTOR_FIXTURE_NAMES, loadSectorFixtures, readSectorFixture } from '../../core/test/support/sectorFixture.ts';
import type { SectorFixtureName } from '../../core/test/support/sectorFixture.ts';
import { SETTINGS, blurOnRemoval, headlessShell, labelled, shellWithDocument } from './helpers/editorFixture';

/**
 * The editor among the other sectors (which neighbours it draws, what the world would report
 * about the document) and the shell's commands, wheel navigation, and overlay commits over a
 * headless composition.
 */

const registry = bundledModelRegistry();

function fixture(name: SectorFixtureName): Sector {
  return readSectorFile(readSectorFixture(name), name);
}

/** A file API holding the committed fixtures. */
function stubFixtureAPI(): void {
  vi.stubGlobal('fetch', (input: string | URL) => {
    const name = decodeURIComponent(String(input).split('/__editor/sectors')[1]!.slice(1));
    if (name === '') return Promise.resolve(new Response(JSON.stringify(SECTOR_FIXTURE_NAMES), { status: 200 }));
    return Promise.resolve(new Response(readSectorFixture(name as SectorFixtureName), { status: 200 }));
  });
}

/** The sector picker's row for a fixture, once the file API has listed it. */
async function pickerRow(shell: EditorShell, name: SectorFixtureName): Promise<HTMLButtonElement> {
  shell.present('sectorPicker');
  return vi.waitFor(() => {
    const found = [...document.querySelectorAll<HTMLButtonElement>('.editor-sector-list button')].find((candidate) => candidate.textContent === name);
    expect(found).toBeDefined();
    return found!;
  });
}

/** Opens a fixture through the sector picker, as a user does, and waits for the other sectors to arrive. */
async function open(shell: EditorShell, name: SectorFixtureName): Promise<void> {
  (await pickerRow(shell, name)).click();
  await vi.waitFor(() => expect(shell.document.sector.name).toBe(name));
  // The other sectors arrive after the document: an interior waits for its door's target.
  const door = fixture(name).doors[0];
  if (door !== undefined) await vi.waitFor(() => expect(shell.issues.records).toEqual([]));
}

/** The dialog an overlay shows, by its title. */
function dialog(title: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${title}"]`)!;
}

function press(root: HTMLElement, label: string): void {
  [...root.querySelectorAll('button')].find((button) => button.textContent === label)!.click();
}

function banner(): HTMLElement {
  return document.querySelector<HTMLElement>('.editor-error-banner')!;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('neighbours', () => {
  const sectors = loadSectorFixtures();
  const others = (name: string): Sector[] => sectors.filter((sector) => sector.name !== name);

  it.each([
    ['EdariaMitte', ['Nordwiese']],
    ['Nordwiese', ['EdariaMitte', 'Nordwald']],
    ['Nordwald', ['Nordwiese']],
    ['EdariaShop', []],
  ] as const)('of %s are %j', (name, expected) => {
    const found = neighbours(fixture(name), others(name)).map((sector) => sector.name);
    expect(found.sort()).toEqual([...expected].sort());
  });

  it('follow the document origin, and leave out a sector the document overlaps', () => {
    const wiese = fixture('Nordwiese');
    const names = (document: Sector): string[] => neighbours(document, others('Nordwiese')).map((sector) => sector.name);
    expect(names({ ...wiese, origin: { x: 40.96, z: 0 } })).toEqual(['EdariaMitte']);
    expect(names({ ...wiese, origin: { x: 200, z: 0 } })).toEqual([]);
    // Deep enough to reach into EdariaMitte, which it then overlaps instead of bordering.
    expect(names({ ...wiese, size: { width: 30.72, depth: 40 } })).toEqual(['Nordwald']);
  });

  it('are drawn read-only beside an outdoor document and dropped when it no longer borders them', async () => {
    stubFixtureAPI();
    const shell = headlessShell();
    await open(shell, 'EdariaMitte');
    const wall = fixture('Nordwiese').placements[0]!.id;
    await vi.waitFor(() => expect(shell.scene.placementNode('Nordwiese', wall)).toBeDefined());
    expect(shell.scene.placementNode('Nordwald', fixture('Nordwald').placements[0]!.id)).toBeUndefined();
    // Neither saved nor part of the document.
    expect(shell.recordCounts().placements).toBe(fixture('EdariaMitte').placements.length);
    expect(shell.document.isDirty).toBe(false);

    shell.document.mutate('Move sector', (sector) => {
      sector.origin = { x: 200, z: 200 };
    });
    expect(shell.scene.placementNode('Nordwiese', wall)).toBeUndefined();
    shell.document.undo();
    expect(shell.scene.placementNode('Nordwiese', wall)).toBeDefined();
  });

  it('takes the sector it showed out of the scene when another is opened', async () => {
    stubFixtureAPI();
    const shell = headlessShell();
    const inScene = (node: THREE.Object3D): boolean => {
      let root = node;
      while (root.parent !== null) root = root.parent;
      return root === shell.scene.scene;
    };
    await open(shell, 'EdariaShop');
    const shown = shell.scene.placementNode('EdariaShop', fixture('EdariaShop').placements[0]!.id)!;
    expect(inScene(shown)).toBe(true);
    await open(shell, 'EdariaInn');
    expect(shell.scene.placementNode('EdariaShop', fixture('EdariaShop').placements[0]!.id)).toBeUndefined();
    expect(inScene(shown)).toBe(false);
    expect(inScene(shell.scene.placementNode('EdariaInn', fixture('EdariaInn').placements[0]!.id)!)).toBe(true);
  });
});

describe('issues', () => {
  const sectors = loadSectorFixtures();
  const mitte = (): Sector => fixture('EdariaMitte');
  const others = sectors.filter((sector) => sector.name !== 'EdariaMitte');

  it.each(SECTOR_FIXTURE_NAMES)('reports none for the committed %s', (name) => {
    expect(issueMessages(documentIssues(fixture(name), sectors, registry))).toEqual([]);
  });

  it('reports a door the server would leave inert, on the document side only', () => {
    const document = mitte();
    const door = document.doors.find((candidate) => candidate.target.sector === 'EdariaShop')!;
    door.target.door = 'cellar';
    expect(issueMessages(documentIssues(document, others, registry))).toEqual([`door "${door.id}": target door "cellar" in EdariaShop does not exist`]);
  });

  it('reports a door whose target sector is not among the files', () => {
    const issues = documentIssues(mitte(), [], registry);
    expect(issues.error).toBeUndefined();
    expect(issues.records.map((issue) => issue.record)).toEqual(['door', 'door', 'door', 'door']);
  });

  it('reports a model the registry does not know and an elevation its walk surfaces ignore', () => {
    const document = mitte();
    const house = document.placements.find((placement) => placement.modelId === 'building-house')!;
    house.elevation = 1;
    document.placements.push({ id: 'odd-1', modelId: 'odd', x: 1, z: 1, yaw: 0, elevation: 0 });
    const records = documentIssues(document, others, registry).records.filter((issue) => issue.record === 'placement');
    expect(records.map((issue) => issue.id).sort()).toEqual([house.id, 'odd-1'].sort());
  });

  it('reports why the world would not load, and still the collision issues of the document', () => {
    const document = mitte();
    document.origin = { x: 5.12, z: -10 };
    document.placements.push({ id: 'odd-1', modelId: 'odd', x: 1, z: 1, yaw: 0, elevation: 0 });
    const issues = documentIssues(document, others, registry);
    expect(issues.error).toMatch(/^outdoor sectors EdariaMitte and Nordwiese overlap$/);
    expect(issues.records.map((issue) => issue.id)).toEqual(['odd-1']);
    expect(issueMessages(issues).length).toBe(2);
  });

  it('are what the debug surface reports, recomputed on every document change', async () => {
    stubFixtureAPI();
    const shell = headlessShell();
    installEditorDebugAPI(shell);
    const debug = (window as unknown as { somnioEditor: { issues(): string[]; body(): Record<string, number>; selection(): unknown[] } }).somnioEditor;
    await open(shell, 'EdariaMitte');
    expect(debug.issues()).toEqual([]);
    const { doors, placements, npcs, monsterSpawns, floorPatches, blockers } = mitte();
    expect(debug.body()).toEqual({
      placements: placements.length,
      blockers: blockers.length,
      doors: doors.length,
      npcs: npcs.length,
      monsterSpawns: monsterSpawns.length,
      floorPatches: floorPatches.length,
    });
    shell.document.mutate('Break door', (sector) => {
      sector.doors[0]!.anchor = 'cellar';
    });
    expect(debug.issues()).toEqual([`door "${doors[0]!.id}": placement "${doors[0]!.placement}" has no door anchor "cellar"`]);
    shell.selectAll();
    expect(debug.selection()).toContainEqual({ kind: 'door', id: doors[0]!.id });
    expect(document.querySelector('.editor-label--issue')?.textContent).toContain(doors[0]!.id);
    shell.document.undo();
    expect(debug.issues()).toEqual([]);
    expect(document.querySelector('.editor-label--issue')).toBeNull();
  });
});

describe('sun shadow', () => {
  it('follows the framing focus through a pan, so props far from the space origin keep their shadows', () => {
    const shell = shellWithDocument();
    const sun = shell.scene.scene.getObjectByProperty('isDirectionalLight', true) as THREE.DirectionalLight;
    const texel = (2 * SUN_SHADOW.orthographicScale) / SUN_SHADOW.mapSize;
    const anchorOffFocus = (): number => {
      const { x, z } = shell.camera.framing.focus;
      return sun.target.position.distanceTo(new THREE.Vector3(x, 0, z));
    };
    // Opened on the sector center, not on the origin of its space.
    expect(shell.camera.framing.focus).toMatchObject({ x: 10, z: 10 });
    expect(anchorOffFocus()).toBeLessThanOrEqual(2 * texel);
    const before = sun.target.position.clone();
    document.querySelector('#somnio-editor-canvas')!.dispatchEvent(new WheelEvent('wheel', { deltaX: 120, deltaY: 90, bubbles: true, cancelable: true }));
    expect(sun.target.position.distanceTo(before)).toBeGreaterThan(1);
    expect(anchorOffFocus()).toBeLessThanOrEqual(2 * texel);
  });
});

describe('wheel', () => {
  /** happy-dom's `WheelEvent` drops the modifier keys of its init, so they are set on the event itself. */
  function wheel(deltas: WheelEventInit, modifiers: { ctrlKey?: boolean; metaKey?: boolean } = {}): void {
    const event = Object.assign(new WheelEvent('wheel', { bubbles: true, cancelable: true, ...deltas }), modifiers);
    document.querySelector('#somnio-editor-canvas')!.dispatchEvent(event);
  }

  it('scrolls the content with the wheel: the ground at the center moves against the deltas', () => {
    const shell = shellWithDocument();
    const { x, z } = shell.camera.framing.focus;
    const { width, height } = shell.camera.viewportSize;
    wheel({ deltaX: 120, deltaY: 90 });
    const moved = screenAtFloorPoint(shell.scene.camera, shell.camera.viewportSize, { x, z });
    expect(moved.x).toBeCloseTo(width / 2 - 120, 6);
    expect(moved.y).toBeCloseTo(height / 2 - 90, 6);
  });

  it('zooms in on a scroll up with the command key held and out on a scroll down, about the same focus', () => {
    const shell = shellWithDocument();
    const opening = structuredClone(shell.camera.framing);
    wheel({ deltaY: -100 }, { ctrlKey: true });
    // One notch magnifies by e^(3.85 x 0.015).
    expect(opening.scale / shell.camera.framing.scale).toBeCloseTo(1.05945, 4);
    expect(shell.camera.framing.focus).toEqual(opening.focus);
    wheel({ deltaY: 200 }, { metaKey: true });
    expect(shell.camera.framing.scale / opening.scale).toBeCloseTo(1.05945, 4);
  });
});

describe('sector settings', () => {
  function apply(shell: EditorShell, values: Record<string, string>): void {
    shell.present('sectorSettings');
    const form = dialog('Sector Settings');
    for (const [label, value] of Object.entries(values)) labelled(form, label).value = value;
    press(form, 'Apply');
  }

  it('renames the sector as one undo step when only the name changed', () => {
    const shell = shellWithDocument();
    const before = structuredClone(shell.document.sector);
    const depth = shell.document.undoDepth;
    apply(shell, { 'Sector name': 'Renamed' });
    expect(shell.document.sector).toEqual({ ...before, name: 'Renamed' });
    expect(shell.document.undoDepth).toBe(depth + 1);
    expect(shell.presentedOverlay).toBeUndefined();
  });

  it('edits the fields in a step of their own, after the rename', () => {
    const shell = shellWithDocument();
    const depth = shell.document.undoDepth;
    apply(shell, { 'Sector name': 'Renamed', 'Width (m)': '24', 'Origin Z (m)': '-8' });
    expect(shell.document.sector).toMatchObject({ name: 'Renamed', size: { width: 24, depth: 20 }, origin: { x: 0, z: -8 } });
    expect(shell.document.undoDepth).toBe(depth + 2);
    expect(shell.presentedOverlay).toBeUndefined();
    shell.undo();
    expect(shell.document.sector).toMatchObject({ name: 'Renamed', size: { width: 20, depth: 20 }, origin: { x: 0, z: 0 } });
  });

  it('stays open over an unchanged document when the document refuses the edit', () => {
    const shell = shellWithDocument();
    shell.document.mutate('Seed', (sector) => {
      sector.npcs.push({ id: 'npc-1', name: '', characterModelId: 'kaempfer-meister', x: 10, z: 19, facing: 0, dialogScript: '' });
    });
    const before = structuredClone(shell.document.sector);
    const depth = shell.document.undoDepth;
    // The NPC would stand past the south edge.
    apply(shell, { 'Depth (m)': '16' });
    expect(shell.document.sector).toEqual(before);
    expect(shell.document.undoDepth).toBe(depth);
    expect(shell.presentedOverlay).toBe('sectorSettings');
    expect(banner().classList.contains('hidden')).toBe(false);
    expect(banner().textContent).toContain('npcs[0]');
  });
});

describe('unsaved changes', () => {
  it('asks before another sector replaces a dirty document, and keeps it on Cancel', async () => {
    stubFixtureAPI();
    const shell = headlessShell();
    shell.document.create(SETTINGS);
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    const row = await pickerRow(shell, 'EdariaShop');
    row.click();
    await new Promise((resolve) => setTimeout(resolve));
    expect(confirm.mock.calls).toEqual([['Discard unsaved changes?']]);
    expect(shell.document.sector.name).toBe('Test');
    expect(shell.presentedOverlay).toBe('sectorPicker');

    confirm.mockReturnValue(true);
    row.click();
    await vi.waitFor(() => expect(shell.document.sector.name).toBe('EdariaShop'));
    expect(shell.document.isDirty).toBe(false);
    expect(shell.presentedOverlay).toBeUndefined();
  });

  it('asks before a new map replaces a dirty document, and keeps it on Cancel', () => {
    const shell = shellWithDocument();
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    shell.present('newMap');
    const form = dialog('Create new map');
    labelled(form, 'Sector name').value = 'Fresh';
    press(form, 'OK');
    expect(confirm.mock.calls).toEqual([['Discard unsaved changes?']]);
    expect(shell.document.sector.name).toBe('Test');
    expect(shell.presentedOverlay).toBe('newMap');

    confirm.mockReturnValue(true);
    press(form, 'OK');
    expect(shell.document.sector).toMatchObject({ name: 'Fresh', size: { width: 32, depth: 32 } });
    expect(shell.presentedOverlay).toBeUndefined();
  });
});

describe('commands', () => {
  function withRecords(): EditorShell {
    const shell = shellWithDocument();
    shell.document.mutate('Seed', (sector) => {
      sector.placements.push({ id: 'door-1', modelId: 'door', x: 10, z: 19, yaw: 0, elevation: 0 });
      sector.doors.push({ id: 'to-shop', placement: 'door-1', anchor: 'main', target: { sector: 'Shop', door: 'exit' } });
      sector.blockers.push({ id: 'blocker-1', x: 2, z: 2, width: 1, depth: 1 });
      sector.floorPatches.push({ id: 'patch-1', floorMaterialId: 'cobble-town', x: 4, z: 4, width: 2, depth: 2 });
      sector.npcs.push({ id: 'npc-1', name: 'Libus', characterModelId: 'kaempfer-meister', x: 14, z: 6, facing: 0, dialogScript: '' });
      sector.monsterSpawns.push({ id: 'spawn-1', kind: 'gespenst', x: 13, z: 12, width: 3, depth: 3, maxAlive: 2 });
      sector.spawn = { x: 8, z: 8, facing: 0 };
    });
    return shell;
  }

  it('duplicates the selection one grid step away under fresh ids, in one undo step', () => {
    const shell = withRecords();
    shell.selection = [
      { kind: 'placement', id: 'door-1' },
      { kind: 'door', id: 'to-shop' },
      { kind: 'blocker', id: 'blocker-1' },
    ];
    const depth = shell.document.undoDepth;
    shell.duplicateSelection();
    const sector = shell.document.sector;
    expect(sector.placements[1]).toMatchObject({ id: 'door-2', x: 10.5, z: 19.5 });
    expect(sector.doors[1]).toMatchObject({ id: 'to-shop-1', placement: 'door-2' });
    expect(sector.blockers[1]).toMatchObject({ id: 'blocker-2', x: 2.5, z: 2.5 });
    expect(shell.selection).toEqual([
      { kind: 'placement', id: 'door-2' },
      { kind: 'blocker', id: 'blocker-2' },
      { kind: 'door', id: 'to-shop-1' },
    ]);
    expect(shell.document.undoDepth).toBe(depth + 1);
  });

  it('pastes the copied records at the last hovered point', () => {
    const shell = withRecords();
    shell.selection = [{ kind: 'blocker', id: 'blocker-1' }];
    shell.copySelection();
    shell.lastHoveredGrid = { x: 12, z: 3 };
    shell.paste();
    expect(shell.document.sector.blockers[1]).toEqual({ id: 'blocker-2', x: 12, z: 3, width: 1, depth: 1 });
    expect(shell.selection).toEqual([{ kind: 'blocker', id: 'blocker-2' }]);
  });

  it('refuses a duplicate the document does not take, through the same path as a paste', () => {
    const shell = withRecords();
    shell.selection = [{ kind: 'floorPatch', id: 'patch-1' }];
    const depth = shell.document.undoDepth;
    shell.duplicateSelection();
    shell.copySelection();
    shell.lastHoveredGrid = { x: 5, z: 5 };
    shell.paste();
    expect(shell.document.sector.floorPatches.length).toBe(1);
    expect(shell.document.undoDepth).toBe(depth);
    expect(shell.selection).toEqual([{ kind: 'floorPatch', id: 'patch-1' }]);
    expect(document.querySelector('.editor-error-banner')?.textContent).toBe('Floor patches must not overlap.');
  });

  it('selects every record, the spawn point included, and deletes them with their doors', () => {
    const shell = withRecords();
    shell.selectAll();
    const all = [
      { kind: 'placement', id: 'door-1' },
      { kind: 'door', id: 'to-shop' },
      { kind: 'blocker', id: 'blocker-1' },
      { kind: 'floorPatch', id: 'patch-1' },
      { kind: 'npc', id: 'npc-1' },
      { kind: 'monsterSpawn', id: 'spawn-1' },
      { kind: 'spawn', id: 'spawn' },
    ];
    expect(shell.selection.length).toBe(all.length);
    expect(shell.selection).toEqual(expect.arrayContaining(all));
    shell.selection = [{ kind: 'placement', id: 'door-1' }];
    shell.deleteSelection();
    expect(shell.document.sector.doors).toEqual([]);
    expect(shell.selection).toEqual([]);
  });

  it('nudges by a centimetre, by the grid step with shift, and not at all for a door on its own', () => {
    const shell = withRecords();
    shell.selection = [{ kind: 'blocker', id: 'blocker-1' }];
    expect(shell.nudgeSelection('ArrowRight', false)).toBe(true);
    expect(shell.nudgeSelection('ArrowUp', true)).toBe(true);
    expect(shell.document.sector.blockers[0]).toMatchObject({ x: 2.01, z: 1.5 });
    const depth = shell.document.undoDepth;
    shell.selection = [{ kind: 'door', id: 'to-shop' }];
    expect(shell.nudgeSelection('ArrowRight', false)).toBe(false);
    expect(shell.nudgeSelection('a', false)).toBe(false);
    expect(shell.document.undoDepth).toBe(depth);
  });

  function typeId(shell: EditorShell, id: string): void {
    const field = labelled(shell.inspector.root, 'Id');
    field.focus();
    field.value = id;
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
  }

  it.each([
    ['fires no blur on removal', false],
    ['blurs an input it removes', true],
  ])('keeps a record selected under the id it is renamed to, in one undo step, where the engine %s', (_engine, blursOnRemoval) => {
    if (blursOnRemoval) blurOnRemoval();
    const shell = withRecords();
    shell.selection = [{ kind: 'blocker', id: 'blocker-1' }];
    shell.inspector.render(shell.document.sector, shell.selection, false);
    // The rename has the rows replaced, the Id field among them, while the field is committing.
    const mutate = vi.spyOn(shell.document, 'mutate');
    const depth = shell.document.undoDepth;
    const field = labelled(shell.inspector.root, 'Id');
    typeId(shell, 'north-wall');
    expect(field.isConnected).toBe(false);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(shell.document.sector.blockers.map((blocker) => blocker.id)).toEqual(['north-wall']);
    expect(shell.selection).toEqual([{ kind: 'blocker', id: 'north-wall' }]);
    expect(labelled(shell.inspector.root, 'Id').value).toBe('north-wall');
    expect(shell.document.undoDepth).toBe(depth + 1);
  });

  it('leaves the selection on the record when the document refuses its new id', () => {
    const shell = withRecords();
    shell.document.mutate('Seed', (sector) => {
      sector.blockers.push({ id: 'fence', x: 12, z: 2, width: 1, depth: 1 });
    });
    shell.selection = [{ kind: 'blocker', id: 'blocker-1' }];
    shell.inspector.render(shell.document.sector, shell.selection, false);
    const depth = shell.document.undoDepth;
    typeId(shell, 'fence');
    expect(shell.document.sector.blockers.map((blocker) => blocker.id)).toEqual(['blocker-1', 'fence']);
    expect(shell.selection).toEqual([{ kind: 'blocker', id: 'blocker-1' }]);
    expect(labelled(shell.inspector.root, 'Id').value).toBe('blocker-1');
    expect(shell.document.undoDepth).toBe(depth);
    expect(banner().classList.contains('hidden')).toBe(false);
  });

  it('adds a door from the inspector and selects it', () => {
    const shell = shellWithDocument();
    shell.document.mutate('Seed', (sector) => {
      sector.placements.push({ id: 'door-1', modelId: 'door', x: 10, z: 19, yaw: 0, elevation: 0 });
    });
    shell.selection = [{ kind: 'placement', id: 'door-1' }];
    shell.inspector.render(shell.document.sector, shell.selection, false);
    const add = [...shell.inspector.root.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Add door'))!;
    add.click();
    const [door] = shell.document.sector.doors;
    expect(door).toMatchObject({ id: 'door-1', placement: 'door-1', target: { sector: '' } });
    expect(shell.selection).toEqual([{ kind: 'door', id: 'door-1' }]);
    // It leads nowhere yet, which is reported in those words rather than as a door missing from a sector with no name.
    expect(issueMessages(shell.issues)).toEqual(['door "door-1": has no target sector']);
    expect(document.querySelector('.editor-label--issue')?.textContent).toBe('door-1 -> no target sector');
  });
});
