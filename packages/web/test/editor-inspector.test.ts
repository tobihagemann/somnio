import { afterEach, describe, expect, it } from 'vitest';
import { SOMNIO_CONSTANTS } from '@somnio/core';
import type { Sector } from '@somnio/core';
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
      npcs: [{ id: 'libus', name: 'Libus', characterModelId: 'hero', x: 2, z: 12, facing: 90, greeting: 'Hallo', dialog: [{ text: 'Servus' }] }],
      monsterSpawns: [{ id: 'spawn-1', kind: 'ghost', x: 12, z: 12, width: 4, depth: 4, maxAlive: 3, eliteChance: 0 }],
      ground: {
        backgroundMaterialId: 'grass-meadow',
        marks: [
          {
            id: 'road',
            materialId: 'dirt-path',
            opacity: 1,
            shape: {
              kind: 'stroke',
              radius: 1,
              points: [
                { x: 12, z: 2 },
                { x: 16, z: 4 },
              ],
            },
          },
          {
            id: 'plaza',
            materialId: 'cobble-town',
            opacity: 1,
            shape: {
              kind: 'polygon',
              points: [
                { x: 2, z: 15 },
                { x: 5, z: 15 },
                { x: 5, z: 18 },
              ],
            },
          },
        ],
      },
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
    if (rename !== undefined) {
      h.selection = followRename(h.selection, rename);
      h.panel.followRename(rename);
    }
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
    h.type('Elite chance', '0.25');
    h.select([{ kind: 'mark', id: 'road' }]);
    h.type('Opacity', '0.5');
    h.type('Radius', '1.5');
    h.select([{ kind: 'spawn', id: 'spawn' }]);
    h.type('X', '7');
    const sector = h.document.sector;
    expect(sector.placements[0]?.elevation).toBe(0.75);
    expect(sector.npcs[0]?.name).toBe('Quieta');
    expect(sector.monsterSpawns[0]).toMatchObject({ depth: 6, maxAlive: 5, eliteChance: 0.25 });
    expect(sector.ground.marks[0]).toMatchObject({ opacity: 0.5, shape: { radius: 1.5 } });
    expect(sector.spawn).toEqual({ x: 7, z: 12, facing: 0 });
  });

  /** Its points never move here, so a stroke's radius stops where its nearest point would leave the bound. */
  it("caps a stroke's radius where its points still lie in bounds, and gives a polygon none", () => {
    const h = harness();
    h.select([{ kind: 'mark', id: 'road' }]);
    // The road's points are 2 m from the north edge, which caps it at 2.825 m.
    h.type('Radius', '6');
    expect(h.document.sector.ground.marks[0]!.shape).toMatchObject({ radius: 2.825 });
    expect(h.input('Radius').value).toBe('2.825');
    h.type('Opacity', '1.7');
    expect(h.document.sector.ground.marks[0]!.opacity).toBe(1);
    h.select([{ kind: 'mark', id: 'plaza' }]);
    expect(h.panel.root.textContent).not.toContain('Radius');
  });

  /** The sector file refuses a chance outside 0 to 1, so the field never puts one in the document. */
  it("holds a monster spawn's elite chance to 0 to 1, in hundredths", () => {
    const h = harness();
    h.select([{ kind: 'monsterSpawn', id: 'spawn-1' }]);
    h.type('Elite chance', '1.5');
    expect(h.document.sector.monsterSpawns[0]!.eliteChance).toBe(1);
    h.type('Elite chance', '-0.2');
    expect(h.document.sector.monsterSpawns[0]!.eliteChance).toBe(0);
    h.type('Elite chance', '0.333');
    expect(h.document.sector.monsterSpawns[0]!.eliteChance).toBe(0.33);
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
    expect([...h.picker('Service').options].map((option) => option.textContent)).toEqual([
      'None',
      'Fighter master',
      'Healer master',
      'Mystic master',
      'Shopkeeper',
      'Bounty board',
    ]);

    choose(h.picker('Service'), 'healerMaster');
    expect(h.document.sector.npcs[0]?.service).toBe('healerMaster');

    choose(h.picker('Service'), '');
    // Removed, not emptied: an NPC without a service is saved without the key.
    expect('service' in h.document.sector.npcs[0]!).toBe(false);

    h.document.undo();
    expect(h.picker('Service').value).toBe('healerMaster');
    h.document.undo();
    expect(h.picker('Service').value).toBe('');
  });
});

describe("an NPC's lines", () => {
  const libus = (h: Harness): Sector['npcs'][number] => h.document.sector.npcs[0]!;
  const textarea = (h: Harness, label: string): HTMLTextAreaElement => h.input(label) as unknown as HTMLTextAreaElement;
  const buttonNamed = (h: Harness, name: string): HTMLButtonElement[] =>
    [...h.panel.root.querySelectorAll<HTMLButtonElement>('button')].filter((candidate) => candidate.textContent === name);
  const stepLabels = (h: Harness): string[] =>
    [...h.panel.root.querySelectorAll('.editor-dialog-step label')].map((label) => label.textContent ?? '').filter((label) => label.startsWith('Step'));
  const optionLabels = (picker: HTMLSelectElement): string[] => [...picker.options].map((option) => option.textContent ?? '');
  /** Types into the New step box, as a keystroke does. */
  const compose = (h: Harness, text: string): void => {
    const box = textarea(h, 'New step');
    box.focus();
    box.value = text;
    box.dispatchEvent(new Event('input'));
  };

  function withSteps(h: Harness, dialog: Sector['npcs'][number]['dialog'], service?: Sector['npcs'][number]['service']): void {
    h.document.mutate('Seed lines', (sector) => {
      sector.npcs[0]!.dialog = dialog;
      if (service !== undefined) sector.npcs[0]!.service = service;
    });
    h.select([{ kind: 'npc', id: 'libus' }]);
  }

  it('writes the greeting on Return as one undo step, and removes the key once it is cleared', () => {
    const h = harness();
    h.select([{ kind: 'npc', id: 'libus' }]);
    const depth = h.document.undoDepth;
    h.type('Greeting', 'Greetings, $name!');
    expect(libus(h).greeting).toBe('Greetings, $name!');
    expect(globalThis.document.activeElement).not.toBe(textarea(h, 'Greeting'));
    expect(h.document.undoDepth).toBe(depth + 1);
    h.type('Greeting', '   ', 'blur');
    expect('greeting' in libus(h)).toBe(false);
    expect(textarea(h, 'Greeting').value).toBe('');
  });

  it("writes a step's text and whom it is for, each as one undo step", () => {
    const h = harness();
    h.select([{ kind: 'npc', id: 'libus' }]);
    const depth = h.document.undoDepth;
    h.type('Step 1', 'New here?', 'blur');
    expect(libus(h).dialog).toEqual([{ text: 'New here?' }]);
    choose(h.picker('For step 1'), 'quest:fighter-trial:offered');
    expect(h.picker('For step 1').selectedOptions[0]?.textContent).toBe('fighter-trial offered');
    expect(libus(h).dialog).toEqual([{ text: 'New here?', when: { quest: 'fighter-trial', state: 'offered' } }]);
    choose(h.picker('For step 1'), '');
    expect(libus(h).dialog).toEqual([{ text: 'New here?' }]);
    expect(h.document.undoDepth).toBe(depth + 3);
  });

  it('adds the new step for whom its For names as one undo step, and empties the box for the next', () => {
    const h = harness();
    h.select([{ kind: 'npc', id: 'libus' }]);
    const depth = h.document.undoDepth;
    compose(h, 'Ready for your trial?');
    choose(h.picker('For new step'), 'quest:fighter-trial:offered');
    const add = buttonNamed(h, 'Add step')[0]!;
    add.focus();
    expect(globalThis.document.activeElement).toBe(add);
    add.click();
    expect(libus(h).dialog).toEqual([{ text: 'Servus' }, { text: 'Ready for your trial?', when: { quest: 'fighter-trial', state: 'offered' } }]);
    expect(h.document.undoDepth).toBe(depth + 1);
    expect(stepLabels(h)).toEqual(['Step 1', 'Step 2']);
    expect(textarea(h, 'New step').value).toBe('');
    expect(h.picker('For new step').value).toBe('');
    expect(globalThis.document.activeElement).toBe(textarea(h, 'New step'));
    // What the box kept goes with the line it added, so coming back finds it empty.
    h.select([]);
    h.select([{ kind: 'npc', id: 'libus' }]);
    expect(textarea(h, 'New step').value).toBe('');
    expect(h.picker('For new step').value).toBe('');
  });

  it('adds the new step on Enter, but not on an Enter an input method takes', () => {
    const h = harness();
    h.select([{ kind: 'npc', id: 'libus' }]);
    compose(h, 'Nihao');
    const press = (init: KeyboardEventInit): KeyboardEvent => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, ...init });
      textarea(h, 'New step').dispatchEvent(event);
      return event;
    };
    // While composing, and WebKit's confirming Enter after the composition ended.
    expect(press({ isComposing: true }).defaultPrevented).toBe(false);
    expect(press({ keyCode: 229 }).defaultPrevented).toBe(false);
    expect(libus(h).dialog).toEqual([{ text: 'Servus' }]);
    expect(press({}).defaultPrevented).toBe(true);
    expect(libus(h).dialog).toEqual([{ text: 'Servus' }, { text: 'Nihao' }]);
  });

  it('commits a name, a greeting, or a step on Return, but not on an Enter an input method takes', () => {
    const h = harness();
    h.select([{ kind: 'npc', id: 'libus' }]);
    for (const [label, committed] of [
      ['Name', 'Libus'],
      ['Greeting', 'Hallo'],
      ['Step 1', 'Servus'],
    ] as const) {
      const area = textarea(h, label);
      area.focus();
      area.value = 'Nihao';
      for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
        const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, ...init });
        area.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
        expect(globalThis.document.activeElement).toBe(area);
      }
      expect(libus(h)).toMatchObject({ name: 'Libus', greeting: 'Hallo', dialog: [{ text: 'Servus' }] });
      // Back to what it was, so leaving the field commits nothing.
      area.value = committed;
    }
  });

  it('adds nothing for a new step that says nothing', () => {
    const h = harness();
    h.select([{ kind: 'npc', id: 'libus' }]);
    const depth = h.document.undoDepth;
    compose(h, '   ');
    buttonNamed(h, 'Add step')[0]!.click();
    expect(libus(h).dialog).toEqual([{ text: 'Servus' }]);
    expect(h.document.undoDepth).toBe(depth);
  });

  it('keeps a new step the document refuses in the box, writing nothing', () => {
    const h = harness();
    h.select([{ kind: 'npc', id: 'libus' }]);
    const depth = h.document.undoDepth;
    const tooLong = 'a'.repeat(SOMNIO_CONSTANTS.npcDialogLineGraphemes + 1);
    choose(h.picker('For new step'), 'role:none');
    compose(h, tooLong);
    buttonNamed(h, 'Add step')[0]!.click();
    expect(libus(h).dialog).toEqual([{ text: 'Servus' }]);
    expect(h.document.undoDepth).toBe(depth);
    expect(textarea(h, 'New step').value).toBe(tooLong);
    expect(h.picker('For new step').value).toBe('role:none');
  });

  it('writes nothing of the new step as focus leaves the box', () => {
    const h = harness();
    h.select([{ kind: 'npc', id: 'libus' }]);
    const depth = h.document.undoDepth;
    compose(h, 'And running is forbidden in here!');
    h.picker('For new step').focus();
    choose(h.picker('For new step'), 'role:none');
    buttonNamed(h, 'Add step')[0]!.focus();
    textarea(h, 'Step 1').focus();
    h.panel.flushDraft();
    expect(libus(h).dialog).toEqual([{ text: 'Servus' }]);
    expect(h.document.undoDepth).toBe(depth);
    expect(textarea(h, 'New step').value).toBe('And running is forbidden in here!');
  });

  it('keeps the new step in the box as the steps change, by a Remove or an undo', () => {
    const h = harness();
    h.select([{ kind: 'npc', id: 'libus' }]);
    const box = textarea(h, 'New step');
    compose(h, 'And running is forbidden in here!');
    buttonNamed(h, 'Remove')[0]!.click();
    expect(libus(h).dialog).toEqual([]);
    h.document.undo();
    expect(libus(h).dialog).toEqual([{ text: 'Servus' }]);
    expect(textarea(h, 'New step')).toBe(box);
    expect(box.value).toBe('And running is forbidden in here!');
  });

  it('keeps the new step of an NPC through selecting another and coming back', () => {
    const h = harness();
    h.document.mutate('Seed NPC', (sector) => {
      sector.npcs.push({ id: 'quieta', name: 'Quieta', characterModelId: 'hero', x: 6, z: 6, facing: 0, dialog: [] });
    });
    h.select([{ kind: 'npc', id: 'libus' }]);
    compose(h, 'And running is forbidden in here!');
    choose(h.picker('For new step'), 'role:none');
    h.select([{ kind: 'npc', id: 'quieta' }]);
    expect(textarea(h, 'New step').value).toBe('');
    expect(h.picker('For new step').value).toBe('');
    h.select([{ kind: 'npc', id: 'libus' }]);
    expect(textarea(h, 'New step').value).toBe('And running is forbidden in here!');
    expect(h.picker('For new step').value).toBe('role:none');
  });

  it('keeps the new step with its NPC through a rename, back through undo and forward through redo', () => {
    const h = harness();
    h.select([{ kind: 'npc', id: 'libus' }]);
    compose(h, 'And running is forbidden in here!');
    choose(h.picker('For new step'), 'role:none');
    h.type('Id', 'libus-elder');
    expect(h.selection).toEqual([{ kind: 'npc', id: 'libus-elder' }]);
    const shown = (): string[] => [textarea(h, 'New step').value, h.picker('For new step').value];
    expect(shown()).toEqual(['And running is forbidden in here!', 'role:none']);
    h.document.undo();
    expect(h.selection).toEqual([{ kind: 'npc', id: 'libus' }]);
    expect(shown()).toEqual(['And running is forbidden in here!', 'role:none']);
    h.document.redo();
    expect(shown()).toEqual(['And running is forbidden in here!', 'role:none']);
  });

  it('keeps the new step of an NPC through a rename of another kind of record that shares its id', () => {
    const h = harness();
    h.document.mutate('Seed blocker', (sector) => {
      sector.blockers[0]!.id = 'libus';
    });
    h.select([{ kind: 'npc', id: 'libus' }]);
    compose(h, 'And running is forbidden in here!');
    h.select([{ kind: 'blocker', id: 'libus' }]);
    h.type('Id', 'wall-two');
    expect(h.document.sector.blockers[0]!.id).toBe('wall-two');
    h.select([{ kind: 'npc', id: 'libus' }]);
    expect(textarea(h, 'New step').value).toBe('And running is forbidden in here!');
  });

  it('drops the new step with its NPC, so another NPC given its id starts empty', () => {
    const h = harness();
    h.select([{ kind: 'npc', id: 'libus' }]);
    compose(h, 'And running is forbidden in here!');
    const npc = structuredClone(libus(h));
    h.select([]);
    h.document.mutate('Delete NPC', (sector) => sector.npcs.splice(0, 1));
    h.document.mutate('Place NPC', (sector) => sector.npcs.push({ ...npc, name: 'Quieta' }));
    h.select([{ kind: 'npc', id: 'libus' }]);
    expect(textarea(h, 'New step').value).toBe('');
  });

  it("puts the new step's For back at Everyone once the service no longer offers it, keeping its text", () => {
    const h = harness();
    withSteps(h, [], 'fighterMaster');
    choose(h.picker('For new step'), 'role:own');
    compose(h, 'Meet a blow with your guard.');
    choose(h.picker('Service'), 'shopkeeper');
    expect(h.picker('For new step').value).toBe('');
    expect(textarea(h, 'New step').value).toBe('Meet a blow with your guard.');
    // The For stays at Everyone when the service comes back, so Add writes what it shows.
    h.document.undo();
    expect(h.picker('For new step').value).toBe('');
    buttonNamed(h, 'Add step')[0]!.click();
    expect(libus(h).dialog).toEqual([{ text: 'Meet a blow with your guard.' }]);
  });

  it('removes a step, and an undo brings back one row per step, each editing its own', () => {
    const h = harness();
    withSteps(h, [{ text: 'First.' }, { text: 'Second.' }, { text: 'Third.' }]);
    buttonNamed(h, 'Remove')[1]!.click();
    expect(libus(h).dialog).toEqual([{ text: 'First.' }, { text: 'Third.' }]);
    expect(stepLabels(h)).toEqual(['Step 1', 'Step 2']);
    h.document.undo();
    expect(stepLabels(h)).toEqual(['Step 1', 'Step 2', 'Step 3']);
    expect(textarea(h, 'Step 2').value).toBe('Second.');
    h.type('Step 2', 'Second, again.');
    expect(libus(h).dialog).toEqual([{ text: 'First.' }, { text: 'Second, again.' }, { text: 'Third.' }]);
  });

  it('offers own role and another role only on a master, following the Service picker', () => {
    const h = harness();
    h.select([{ kind: 'npc', id: 'libus' }]);
    const roles = (): string[] => optionLabels(h.picker('For step 1')).slice(0, 4);
    expect(roles()).toEqual(['Everyone', 'No role', 'fighter-trial offered', 'fighter-trial held']);
    choose(h.picker('Service'), 'fighterMaster');
    expect(roles()).toEqual(['Everyone', 'No role', 'Own role', 'Another role']);
    choose(h.picker('Service'), 'shopkeeper');
    expect(roles()).toEqual(['Everyone', 'No role', 'fighter-trial offered', 'fighter-trial held']);
  });

  it("refuses a service that is no master's for an NPC with an own-role step", () => {
    const h = harness();
    withSteps(h, [{ text: 'Meet a blow with your guard.', when: { role: 'own' } }], 'fighterMaster');
    const depth = h.document.undoDepth;
    choose(h.picker('Service'), 'shopkeeper');
    expect(libus(h).service).toBe('fighterMaster');
    expect(libus(h).dialog).toEqual([{ text: 'Meet a blow with your guard.', when: { role: 'own' } }]);
    expect(h.document.undoDepth).toBe(depth);
    expect(h.picker('Service').value).toBe('fighterMaster');
    expect(h.picker('For step 1').value).toBe('role:own');
  });

  it.each([
    ['runs past the line budget', 'a'.repeat(SOMNIO_CONSTANTS.npcDialogLineGraphemes + 1)],
    ['says nothing', '   '],
  ])('reverts a step that %s', (_name, typed) => {
    const h = harness();
    h.select([{ kind: 'npc', id: 'libus' }]);
    const depth = h.document.undoDepth;
    h.type('Step 1', typed, 'blur');
    expect(textarea(h, 'Step 1').value).toBe('Servus');
    expect(libus(h).dialog).toEqual([{ text: 'Servus' }]);
    expect(h.document.undoDepth).toBe(depth);
  });
});

describe("a placement's service", () => {
  it('attaches a fixture carrying the one chosen, changes it in place, and takes it away by None, each as one undo step', () => {
    const h = harness();
    h.select([{ kind: 'placement', id: 'box-1' }]);
    expect(h.picker('Service').value).toBe('');
    const depth = h.document.undoDepth;

    choose(h.picker('Service'), 'bountyBoard');
    expect(h.document.sector.fixtures).toEqual([{ id: 'fixture-1', placement: 'box-1', service: 'bountyBoard' }]);
    choose(h.picker('Service'), 'shopkeeper');
    expect(h.document.sector.fixtures).toEqual([{ id: 'fixture-1', placement: 'box-1', service: 'shopkeeper' }]);
    choose(h.picker('Service'), '');
    expect(h.document.sector.fixtures).toEqual([]);
    expect(h.document.undoDepth).toBe(depth + 3);

    h.document.undo();
    expect(h.picker('Service').value).toBe('shopkeeper');
    h.select([{ kind: 'placement', id: 'door-1' }]);
    expect(h.picker('Service').value).toBe('');
  });

  it('keeps the fixture on the placement through a rename', () => {
    const h = harness();
    h.select([{ kind: 'placement', id: 'box-1' }]);
    choose(h.picker('Service'), 'bountyBoard');
    h.type('Id', 'notice-board-1');
    expect(h.document.sector.fixtures).toEqual([{ id: 'fixture-1', placement: 'notice-board-1', service: 'bountyBoard' }]);
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

  it('opens a door only at night when ticked, and removes the key again when not, each as one undo step', () => {
    const h = harness();
    h.select([{ kind: 'door', id: 'to-shop' }]);
    const nightOnly = h.input('Opens only at night');
    expect(nightOnly.checked).toBe(false);

    nightOnly.click();
    expect(h.document.sector.doors[0]?.nightOnly).toBe(true);
    nightOnly.click();
    // Removed, not set false: a door open at every hour is saved without the key.
    expect('nightOnly' in h.document.sector.doors[0]!).toBe(false);

    h.document.undo();
    expect(h.input('Opens only at night').checked).toBe(true);
    h.document.undo();
    expect(h.input('Opens only at night').checked).toBe(false);
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
