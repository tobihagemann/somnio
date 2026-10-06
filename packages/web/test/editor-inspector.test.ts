import { afterEach, describe, expect, it } from 'vitest';
import type { Sector } from '@somnio/core';
import { SOMNIO_PROTOCOL_CONSTANTS } from '@somnio/protocol';
import { EditorDocument } from '@/editor/document';
import { followRename, renameRecord } from '@/editor/selection';
import type { EditorSelection } from '@/editor/selection';
import type { DocumentIssues } from '@/editor/surroundings';
import { InspectorPanel } from '@/editor/ui/inspector';
import { TEST_REGISTRY, interiorSector, outdoorSector } from '../../core/test/support/worldFixture.ts';

/**
 * The inspector against a real document: a field commits once on Return or blur, reverts what
 * it cannot parse and what the document refuses, follows undo without losing a draft being
 * typed, and the pickers a door needs follow the placement's model and the other sectors.
 */

const OTHER = interiorSector('Shop', {
  placements: [{ id: 'door-1', modelId: 'door', x: 5, z: 9, yaw: 0, elevation: 0 }],
  doors: [
    { id: 'exit', placement: 'door-1', anchor: 'main', target: { sector: 'Test', door: 'to-shop' } },
    { id: 'cellar', placement: 'door-1', anchor: 'main', target: { sector: 'Cellar', door: 'up' } },
  ],
});

function body(): Sector {
  return outdoorSector(
    'Test',
    { x: 0, z: 0 },
    {
      placements: [
        { id: 'box-1', modelId: 'box', x: 4, z: 4, yaw: 0, elevation: 0 },
        { id: 'door-1', modelId: 'door', x: 10, z: 19, yaw: 0, elevation: 0 },
      ],
      blockers: [
        { id: 'wall', x: 1, z: 2, width: 3, depth: 1 },
        { id: 'fence', x: 8, z: 2, width: 3, depth: 1 },
      ],
      doors: [{ id: 'to-shop', placement: 'door-1', anchor: 'main', target: { sector: 'Shop', door: 'exit' } }],
      npcs: [{ id: 'libus', name: 'Libus', characterModelId: 'hero', x: 2, z: 12, facing: 90, dialogScript: 'Hallo' }],
      monsterSpawns: [{ id: 'spawn-1', kind: 'gespenst', x: 12, z: 12, width: 4, depth: 4, maxAlive: 3 }],
      floorPatches: [{ id: 'patch-1', floorMaterialId: 'cobble', x: 12, z: 2, width: 3, depth: 2 }],
      spawn: { x: 6, z: 12, facing: 0 },
    },
  );
}

interface Harness {
  document: EditorDocument;
  panel: InspectorPanel;
  selection: EditorSelection[];
  issues: DocumentIssues;
  events: string[];
  select(selection: EditorSelection[]): void;
  input(label: string): HTMLInputElement;
  picker(label: string): HTMLSelectElement;
  type(label: string, text: string, key?: 'Enter' | 'blur'): void;
}

function harness(): Harness {
  const document = new EditorDocument();
  document.commit('Seed', body());
  const control = <E extends Element>(label: string): E => {
    const node = [...h.panel.root.querySelectorAll('label')].find((candidate) => candidate.textContent === label);
    if (node === undefined) throw new Error(`no field labelled "${label}"`);
    return globalThis.document.getElementById(node.getAttribute('for')!) as unknown as E;
  };
  const h: Harness = {
    document,
    selection: [],
    issues: { error: undefined, records: [] },
    events: [],
    panel: new InspectorPanel(
      {
        mutate: (actionName, change) => document.mutate(actionName, change),
        rename: (selection, id) => {
          const rename = { from: selection, to: { kind: selection.kind, id } };
          return document.mutate('Rename record', (sector) => renameRecord(selection, id, sector), rename).accepted;
        },
        onSelect: (selection) => h.events.push(`select ${selection.kind} ${selection.id}`),
        onAddDoor: (placementId, anchor) => h.events.push(`add door ${placementId} ${anchor}`),
        onDeleteSelection: () => h.events.push('delete'),
        onOpenSectorSettings: () => h.events.push('settings'),
        otherSectors: () => [OTHER],
        issues: () => h.issues,
      },
      TEST_REGISTRY,
    ),
    select: (selection) => {
      h.selection = selection;
      h.panel.render(document.sector, h.selection, false);
    },
    input: (label) => control<HTMLInputElement>(label),
    picker: (label) => control<HTMLSelectElement>(label),
    type: (label, text, key = 'Enter') => {
      const field = control<HTMLInputElement>(label);
      field.focus();
      field.value = text;
      if (key === 'blur') field.blur();
      else field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    },
  };
  document.onChanged = (rename) => {
    if (rename !== undefined) h.selection = followRename(h.selection, rename);
    h.panel.render(document.sector, h.selection, false);
  };
  globalThis.document.body.append(h.panel.root);
  h.select([]);
  return h;
}

function choose(picker: HTMLSelectElement, value: string): void {
  picker.value = value;
  picker.dispatchEvent(new Event('change'));
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('field commit', () => {
  it.each(['Enter', 'blur'] as const)('commits on %s as exactly one undo step, to the millimetre', (key) => {
    const h = harness();
    h.select([{ kind: 'blocker', id: 'wall' }]);
    const depth = h.document.undoDepth;
    h.type('X', '3.14159', key);
    expect(h.document.sector.blockers[0]?.x).toBe(3.142);
    expect(h.input('X').value).toBe('3.142');
    expect(h.document.undoDepth).toBe(depth + 1);
    // Blurring the committed field afterwards commits nothing again.
    h.input('X').blur();
    expect(h.document.undoDepth).toBe(depth + 1);
  });

  it.each(['', '   ', 'abc', '1e999'])('reverts the unparseable draft %j without a commit', (text) => {
    const h = harness();
    h.select([{ kind: 'blocker', id: 'wall' }]);
    const depth = h.document.undoDepth;
    h.type('Width', text);
    expect(h.input('Width').value).toBe('3');
    expect(h.document.undoDepth).toBe(depth);
  });

  it('skips the commit for a draft that renders to the committed value', () => {
    const h = harness();
    h.select([{ kind: 'blocker', id: 'wall' }]);
    const depth = h.document.undoDepth;
    h.type('Width', '3.0000');
    expect(h.input('Width').value).toBe('3');
    expect(h.document.undoDepth).toBe(depth);
  });

  it('reverts a value the document refuses', () => {
    const h = harness();
    h.select([{ kind: 'blocker', id: 'wall' }]);
    const depth = h.document.undoDepth;
    h.type('Width', '0');
    expect(h.input('Width').value).toBe('3');
    expect(h.document.sector.blockers[0]?.width).toBe(3);
    expect(h.document.undoDepth).toBe(depth);
    // The refused draft is not taken for the committed value: typed again, it is refused again.
    h.type('Width', '0');
    expect(h.input('Width').value).toBe('3');
    h.select([{ kind: 'monsterSpawn', id: 'spawn-1' }]);
    h.type('Max alive', '2.5');
    expect(h.input('Max alive').value).toBe('3');
  });

  it.each([
    [{ kind: 'placement', id: 'box-1' }, 'Yaw', '-90', '270'],
    [{ kind: 'npc', id: 'libus' }, 'Facing', '450', '90'],
    [{ kind: 'spawn', id: 'spawn' }, 'Facing', '-0.5', '359.5'],
  ] as const)('folds the angle of a %o into one turn', (selection, label, typed, shown) => {
    const h = harness();
    h.select([selection]);
    h.type(label, '45');
    h.type(label, typed);
    expect(h.input(label).value).toBe(shown);
  });

  it('edits every kind through its own fields', () => {
    const h = harness();
    h.select([{ kind: 'placement', id: 'box-1' }]);
    h.type('Elevation', '0.75');
    h.select([{ kind: 'npc', id: 'libus' }]);
    h.type('Name', 'Quieta');
    h.select([{ kind: 'monsterSpawn', id: 'spawn-1' }]);
    h.type('Depth', '6');
    h.type('Max alive', '5');
    h.select([{ kind: 'floorPatch', id: 'patch-1' }]);
    h.type('Z', '3');
    h.select([{ kind: 'spawn', id: 'spawn' }]);
    h.type('X', '7');
    const sector = h.document.sector;
    expect(sector.placements[0]?.elevation).toBe(0.75);
    expect(sector.npcs[0]?.name).toBe('Quieta');
    expect(sector.monsterSpawns[0]).toMatchObject({ depth: 6, maxAlive: 5 });
    expect(sector.floorPatches[0]?.z).toBe(3);
    expect(sector.spawn).toEqual({ x: 7, z: 12, facing: 0 });
  });

  it('commits a dialog script on Return and keeps the newline of Shift-Return', () => {
    const h = harness();
    h.select([{ kind: 'npc', id: 'libus' }]);
    const script = h.input('Script') as unknown as HTMLTextAreaElement;
    const depth = h.document.undoDepth;
    script.focus();
    script.value = 'Hallo\n---\nServus';
    const shifted = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true });
    script.dispatchEvent(shifted);
    expect(shifted.defaultPrevented).toBe(false);
    expect(h.document.sector.npcs[0]?.dialogScript).toBe('Hallo');
    script.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    expect(h.document.sector.npcs[0]?.dialogScript).toBe('Hallo\n---\nServus');
    // Return leaves the field, and the blur that follows commits nothing again.
    expect(globalThis.document.activeElement).not.toBe(script);
    expect(h.document.undoDepth).toBe(depth + 1);
  });

  it('commits a dialog script on blur as exactly one undo step', () => {
    const h = harness();
    h.select([{ kind: 'npc', id: 'libus' }]);
    const script = h.input('Script') as unknown as HTMLTextAreaElement;
    const depth = h.document.undoDepth;
    script.focus();
    script.value = 'Hallo\n---\nServus';
    script.blur();
    expect(h.document.sector.npcs[0]?.dialogScript).toBe('Hallo\n---\nServus');
    expect(h.document.undoDepth).toBe(depth + 1);
    script.focus();
    script.blur();
    expect(h.document.undoDepth).toBe(depth + 1);
  });

  it('reverts a dialog script the document refuses', () => {
    const h = harness();
    h.select([{ kind: 'npc', id: 'libus' }]);
    const script = h.input('Script') as unknown as HTMLTextAreaElement;
    const depth = h.document.undoDepth;
    // One step longer than a say may be. Typed a second time, it is refused a second time.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      script.focus();
      script.value = 'a'.repeat(SOMNIO_PROTOCOL_CONSTANTS.maxSayUTF8Bytes + 1);
      script.blur();
      expect(script.value).toBe('Hallo');
    }
    expect(h.document.sector.npcs[0]?.dialogScript).toBe('Hallo');
    expect(h.document.undoDepth).toBe(depth);
  });
});

describe('reseed lifecycle', () => {
  it('rebuilds the rows only when the selection identity changes', () => {
    const h = harness();
    h.select([{ kind: 'blocker', id: 'wall' }]);
    const field = h.input('X');
    h.document.mutate('Move', (sector) => {
      sector.blockers[0]!.x = 5;
    });
    expect(h.input('X')).toBe(field);
    expect(field.value).toBe('5');
    h.select([{ kind: 'blocker', id: 'fence' }]);
    expect(h.input('X')).not.toBe(field);
    expect(h.input('X').value).toBe('8');
  });

  it('follows an undo in a focused field the user has not typed into', () => {
    const h = harness();
    h.select([{ kind: 'blocker', id: 'wall' }]);
    h.type('X', '5');
    expect(globalThis.document.activeElement).toBe(h.input('X'));
    h.document.undo();
    expect(h.input('X').value).toBe('1');
    // The stale draft must not come back as a commit when the field is left.
    const depth = h.document.undoDepth;
    h.input('X').blur();
    expect(h.document.sector.blockers[0]?.x).toBe(1);
    expect(h.document.undoDepth).toBe(depth);
  });

  it('keeps a draft being typed when the document changes underneath it', () => {
    const h = harness();
    h.select([{ kind: 'blocker', id: 'wall' }]);
    const field = h.input('X');
    field.focus();
    field.value = '7.';
    h.document.mutate('Move elsewhere', (sector) => {
      sector.blockers[0]!.z = 9;
      sector.blockers[0]!.x = 2;
    });
    expect(field.value).toBe('7.');
    expect(h.input('Z').value).toBe('9');
    field.value = '7.5';
    field.blur();
    expect(h.document.sector.blockers[0]).toMatchObject({ x: 7.5, z: 9 });
  });

  it('refreshes a picker on undo, and keeps an id the registry no longer maps', () => {
    const h = harness();
    h.select([{ kind: 'placement', id: 'box-1' }]);
    choose(h.picker('Model'), 'rug');
    expect(h.document.sector.placements[0]?.modelId).toBe('rug');
    h.document.undo();
    expect(h.picker('Model').value).toBe('box');
    h.document.mutate('Unmap', (sector) => {
      sector.placements[0]!.modelId = 'retired-prop';
    });
    expect(h.picker('Model').value).toBe('retired-prop');
    expect(h.picker('Model').selectedOptions[0]?.textContent).toBe('retired-prop (unmapped)');
  });
});

describe("an NPC's service", () => {
  it('is written when one is chosen and removed again by None, each as one undo step', () => {
    const h = harness();
    h.select([{ kind: 'npc', id: 'libus' }]);
    expect(h.picker('Service').value).toBe('');
    expect([...h.picker('Service').options].map((option) => option.textContent)).toEqual(['None', 'Kämpfer master', 'Heiler master']);

    choose(h.picker('Service'), 'heilerMaster');
    expect(h.document.sector.npcs[0]?.service).toBe('heilerMaster');

    choose(h.picker('Service'), '');
    // Removed, not emptied: an NPC without a service is saved without the key.
    expect('service' in h.document.sector.npcs[0]!).toBe(false);

    h.document.undo();
    expect(h.picker('Service').value).toBe('heilerMaster');
    h.document.undo();
    expect(h.picker('Service').value).toBe('');
  });
});

describe('ids', () => {
  it('renames a placement, re-points its doors, and shows the new id', () => {
    const h = harness();
    h.select([{ kind: 'placement', id: 'door-1' }]);
    const depth = h.document.undoDepth;
    h.type('Id', 'gate');
    expect(h.document.sector.placements[1]?.id).toBe('gate');
    expect(h.document.sector.doors[0]?.placement).toBe('gate');
    expect(h.document.undoDepth).toBe(depth + 1);
    expect(h.input('Id').value).toBe('gate');
  });

  it.each([
    ['one the codec does not allow', 'North Wall'],
    ['one another record of the kind carries', 'fence'],
  ])('reverts an id that is %s', (_name, id) => {
    const h = harness();
    h.select([{ kind: 'blocker', id: 'wall' }]);
    const depth = h.document.undoDepth;
    h.type('Id', id);
    expect(h.input('Id').value).toBe('wall');
    expect(h.document.sector.blockers[0]?.id).toBe('wall');
    expect(h.document.undoDepth).toBe(depth);
  });

  it('offers no id for the one spawn point', () => {
    const h = harness();
    h.select([{ kind: 'spawn', id: 'spawn' }]);
    expect(() => h.input('Id')).toThrow(/no field/);
  });
});

describe('doors', () => {
  const options = (picker: HTMLSelectElement): string[] => [...picker.options].map((option) => option.value);

  it('offers a door at each free anchor of a placement model, and a way to the doors it has', () => {
    const h = harness();
    h.select([{ kind: 'placement', id: 'door-1' }]);
    const buttons = (): HTMLButtonElement[] => [...h.panel.root.querySelectorAll<HTMLButtonElement>('.editor-door-list button')];
    expect(buttons().map((button) => button.textContent)).toEqual(['Door to-shop']);
    buttons()[0]!.click();
    h.document.mutate('Remove door', (sector) => {
      sector.doors = [];
    });
    expect(buttons().map((button) => button.textContent)).toEqual(['Add door at main']);
    buttons()[0]!.click();
    expect(h.events).toEqual(['select door to-shop', 'add door door-1 main']);
    // A model with no anchors offers nothing.
    h.select([{ kind: 'placement', id: 'box-1' }]);
    expect(buttons()).toEqual([]);
  });

  it('picks the target among the other sectors and their doors', () => {
    const h = harness();
    h.select([{ kind: 'door', id: 'to-shop' }]);
    expect(options(h.picker('Anchor'))).toEqual(['main']);
    expect(options(h.picker('Target sector'))).toEqual(['', 'Shop']);
    expect(options(h.picker('Target door'))).toEqual(['exit', 'cellar']);
    choose(h.picker('Target door'), 'cellar');
    expect(h.document.sector.doors[0]?.target).toEqual({ sector: 'Shop', door: 'cellar' });
    // With no target sector there are no doors to offer; the stored one stays, marked.
    choose(h.picker('Target sector'), '');
    expect(h.document.sector.doors[0]?.target).toEqual({ sector: '', door: 'cellar' });
    expect(options(h.picker('Target door'))).toEqual(['cellar']);
    expect(h.picker('Target door').selectedOptions[0]?.textContent).toBe('cellar (unmapped)');
    h.document.undo();
    expect(options(h.picker('Target door'))).toEqual(['exit', 'cellar']);
    expect(h.picker('Target door').value).toBe('cellar');
  });
});

describe('issues', () => {
  it('lists every issue in the sector summary and the selected record its own', () => {
    const h = harness();
    h.issues = {
      error: 'outdoor sectors Test and Mitte overlap',
      records: [
        { sector: 'Test', record: 'door', id: 'to-shop', message: 'target door "exit" in Shop does not point back' },
        { sector: 'Test', record: 'placement', id: 'box-1', message: 'walk surfaces overlap' },
      ],
    };
    const lines = (): string[] => [...h.panel.root.querySelectorAll('.editor-issue')].map((line) => line.textContent ?? '');
    h.select([]);
    expect(lines()).toEqual([
      'outdoor sectors Test and Mitte overlap',
      'door "to-shop": target door "exit" in Shop does not point back',
      'placement "box-1": walk surfaces overlap',
    ]);
    h.select([{ kind: 'door', id: 'to-shop' }]);
    expect(lines()).toEqual(['target door "exit" in Shop does not point back']);
    h.issues = { error: undefined, records: [] };
    h.document.mutate('Fix', (sector) => {
      sector.doors[0]!.target.door = 'cellar';
    });
    expect(lines()).toEqual([]);
  });
});

describe('selection shapes', () => {
  it('shows the count and a delete for several records, and the sector for none', () => {
    const h = harness();
    h.select([
      { kind: 'blocker', id: 'wall' },
      { kind: 'blocker', id: 'fence' },
    ]);
    expect(h.panel.root.textContent).toContain('2 selected');
    h.panel.root.querySelector<HTMLButtonElement>('button')!.click();
    h.select([]);
    expect(h.panel.root.textContent).toContain('20 x 20 m');
    h.panel.root.querySelector<HTMLButtonElement>('button')!.click();
    expect(h.events).toEqual(['delete', 'settings']);
  });

  it('shows nothing to edit for a record that is gone', () => {
    const h = harness();
    h.select([{ kind: 'blocker', id: 'gone' }]);
    expect(h.panel.root.querySelectorAll('input').length).toBe(0);
  });
});
