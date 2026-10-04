import { MONSTER_KIND_IDS, heading, objectModel } from '@somnio/core';
import type { ModelRegistry, Sector } from '@somnio/core';
import { button, element, field, replaceChildren, select } from '@/ui/dom';
import { millimetres } from '../preferences';
import { byId, isValidId, isValidSelection, selectionKey } from '../selection';
import type { EditorSelection } from '../selection';
import { issueMessages } from '../surroundings';
import type { DocumentIssues } from '../surroundings';
import { setSelectValue } from './editorDom';
import { reseeded } from './inspectorDraft';

/**
 * The persistent live inspector (top-trailing, 300px) editing the selected record's fields in
 * place. No selection shows the
 * sector-level summary; a multi-selection shows the count plus Delete; a single selection
 * edits every persisted field of its kind — direct placement seeds defaults, so this panel
 * is the only way to refine them.
 *
 * Text fields follow the draft lifecycle (`inspectorDraft.ts`): commit on Return or blur,
 * never per keystroke, so each committed edit is exactly one undo step and one scene
 * reconcile; an unparseable draft reverts, as does one the document refuses, and an equal value
 * skips the commit. Rows are rebuilt only when the selection identity changes — on a document
 * change with the same selection, each field refreshes through the reseed rule so a focused edit
 * is never lost.
 */

export interface InspectorCallbacks {
  mutate(actionName: string, change: (sector: Sector) => void): { accepted: boolean };
  /** Gives the selected record a new id; `false` when the document refused it. */
  rename(selection: EditorSelection, id: string): boolean;
  onSelect(selection: EditorSelection): void;
  onAddDoor(placementId: string, anchor: string): void;
  onDeleteSelection(): void;
  onOpenSectorSettings(): void;
  /** The other sectors the file API holds, which a door can lead to. */
  otherSectors(): readonly Sector[];
  issues(): DocumentIssues;
}

interface DraftField {
  row: HTMLElement;
  refresh(sector: Sector): void;
}

interface PickerOption {
  value: string;
  label: string;
}

/** Finds the record a field edits in whichever body it is handed: the live one to read, a commit's copy to write. */
type Find<R> = (sector: Sector) => R | undefined;

const POSITION_FIELDS = [
  ['X', 'x'],
  ['Z', 'z'],
] as const;

const RECT_FIELDS = [...POSITION_FIELDS, ['Width', 'width'], ['Depth', 'depth']] as const;

function idOptions(ids: readonly string[]): PickerOption[] {
  return ids.map((id) => ({ value: id, label: id }));
}

export class InspectorPanel {
  readonly root: HTMLElement;

  private readonly callbacks: InspectorCallbacks;
  private readonly registry: ModelRegistry;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;
  private fields: DraftField[] = [];
  /** Selection identity of the currently built rows, so a reseed never hits foreign fields. */
  private renderedKey = '';

  constructor(callbacks: InspectorCallbacks, registry: ModelRegistry) {
    this.callbacks = callbacks;
    this.registry = registry;
    this.title = element('h1', { className: 'overlay-title', text: 'Sector' });
    this.body = element('div');
    this.root = element('div', {
      className: 'fantasy-panel editor-inspector',
      children: [this.title, this.body],
    });
  }

  /**
   * Commits what is being typed into the focused field, as leaving the field would. For a caller
   * about to act on the document or to have the rows replaced: removing a focused input does not
   * commit it by itself, since Chromium blurs an input it removes and Firefox and Safari do not.
   */
  flushDraft(): void {
    const focused = globalThis.document.activeElement;
    if (focused instanceof HTMLElement && this.body.contains(focused)) focused.blur();
  }

  render(sector: Sector, selection: readonly EditorSelection[], isUninitialized: boolean): void {
    const key = selection.length === 0 ? 'sector' : selection.map(selectionKey).sort().join(',');
    if (key !== this.renderedKey || selection.length === 0) this.rebuild(sector, selection, isUninitialized, key);
    // Rows just built are seeded here too: nothing in them is focused, so the reseed rule fills
    // each field with its committed rendering.
    for (const draftField of this.fields) draftField.refresh(sector);
  }

  private rebuild(sector: Sector, selection: readonly EditorSelection[], isUninitialized: boolean, key: string): void {
    this.renderedKey = key;
    this.fields = [];
    if (selection.length === 0) {
      this.title.textContent = 'Sector';
      this.renderSectorSummary(sector, isUninitialized);
      return;
    }
    if (selection.length > 1) {
      this.title.textContent = 'Selection';
      replaceChildren(this.body, [element('p', { text: `${selection.length} selected` }), button('Delete', () => this.callbacks.onDeleteSelection())]);
      return;
    }
    const selected = selection[0]!;
    if (!isValidSelection(selected, sector)) {
      replaceChildren(this.body, []);
      return;
    }
    switch (selected.kind) {
      case 'placement':
        this.title.textContent = 'Model';
        this.renderPlacement(selected);
        break;
      case 'blocker':
        this.title.textContent = 'Blocker';
        this.setRows([this.idField(selected), ...this.numberFields(RECT_FIELDS, (s) => byId(s.blockers, selected.id), 'Edit blocker')]);
        break;
      case 'door':
        this.title.textContent = 'Door';
        this.renderDoor(selected);
        break;
      case 'npc':
        this.title.textContent = 'NPC';
        this.renderNPC(selected);
        break;
      case 'monsterSpawn':
        this.title.textContent = 'Monster spawn';
        this.renderMonsterSpawn(selected);
        break;
      case 'floorPatch':
        this.title.textContent = 'Floor patch';
        this.renderFloorPatch(selected);
        break;
      case 'spawn':
        this.title.textContent = 'Spawn point';
        this.setRows([
          ...this.numberFields(POSITION_FIELDS, (s) => s.spawn, 'Edit spawn point'),
          this.numberField('Facing', (s) => s.spawn, 'facing', 'Edit spawn point', heading),
        ]);
        break;
    }
  }

  private renderSectorSummary(sector: Sector, isUninitialized: boolean): void {
    const row = (label: string, value: string): HTMLElement =>
      element('div', {
        className: 'editor-summary-row',
        children: [element('span', { className: 'editor-summary-label', text: label }), element('span', { className: 'editor-summary-value', text: value })],
      });
    const settings = button('Sector Settings...', () => this.callbacks.onOpenSectorSettings());
    settings.disabled = isUninitialized;
    replaceChildren(this.body, [
      row('Sector name', sector.name),
      row('Kind', sector.kind),
      row('Size', `${sector.size.width} x ${sector.size.depth} m`),
      sector.origin === undefined ? row('Light', String(sector.brightness)) : row('Origin', `${sector.origin.x}, ${sector.origin.z}`),
      row('Floor material', sector.floorMaterialId),
      ...issueMessages(this.callbacks.issues()).map(issueLine),
      settings,
    ]);
  }

  private renderPlacement(selection: EditorSelection): void {
    const actionName = 'Edit model';
    const placement: Find<Sector['placements'][number]> = (s) => byId(s.placements, selection.id);
    this.setRows([
      this.idField(selection),
      this.picker('Model', () => idOptions(this.registry.objectModels.map((rule) => rule.id)), placement, 'modelId', actionName),
      ...this.numberFields(POSITION_FIELDS, placement, actionName),
      this.numberField('Yaw', placement, 'yaw', actionName, heading),
      this.numberField('Elevation', placement, 'elevation', actionName),
      this.doorList(selection.id),
      this.issueLines(selection),
    ]);
  }

  private renderDoor(selection: EditorSelection): void {
    const actionName = 'Edit door';
    const door: Find<Sector['doors'][number]> = (s) => byId(s.doors, selection.id);
    const target: Find<Sector['doors'][number]['target']> = (s) => door(s)?.target;
    const anchors = (s: Sector): string[] => {
      const placement = byId(s.placements, door(s)?.placement ?? '');
      return (objectModel(this.registry, placement?.modelId ?? '')?.doors ?? []).map((anchor) => anchor.id);
    };
    const targetDoors = (s: Sector): string[] => {
      const targetSector = this.callbacks.otherSectors().find((other) => other.name === target(s)?.sector);
      return (targetSector?.doors ?? []).map((candidate) => candidate.id);
    };
    this.setRows([
      this.idField(selection),
      this.picker('Anchor', (s) => idOptions(anchors(s)), door, 'anchor', actionName),
      this.picker(
        'Target sector',
        () => [{ value: '', label: '(none)' }, ...idOptions(this.callbacks.otherSectors().map((other) => other.name))],
        target,
        'sector',
        actionName,
      ),
      this.picker('Target door', (s) => idOptions(targetDoors(s)), target, 'door', actionName),
      this.issueLines(selection),
    ]);
  }

  private renderNPC(selection: EditorSelection): void {
    const actionName = 'Edit NPC';
    const npc: Find<Sector['npcs'][number]> = (s) => byId(s.npcs, selection.id);
    this.setRows([
      this.idField(selection),
      this.textField('Name', npc, 'name', actionName),
      this.picker('Character', () => idOptions(this.registry.characterModels.map((rule) => rule.id)), npc, 'characterModelId', actionName),
      ...this.numberFields(POSITION_FIELDS, npc, actionName),
      this.numberField('Facing', npc, 'facing', actionName, heading),
      this.scriptField(selection.id, npc, actionName),
    ]);
  }

  private renderMonsterSpawn(selection: EditorSelection): void {
    const actionName = 'Edit monster spawn';
    const spawn: Find<Sector['monsterSpawns'][number]> = (s) => byId(s.monsterSpawns, selection.id);
    this.setRows([
      this.idField(selection),
      this.picker('Kind', () => idOptions(MONSTER_KIND_IDS), spawn, 'kind', actionName),
      ...this.numberFields(RECT_FIELDS, spawn, actionName),
      this.numberField('Max alive', spawn, 'maxAlive', actionName, (value) => value),
    ]);
  }

  private renderFloorPatch(selection: EditorSelection): void {
    const actionName = 'Edit floor patch';
    const patch: Find<Sector['floorPatches'][number]> = (s) => byId(s.floorPatches, selection.id);
    this.setRows([
      this.idField(selection),
      this.picker('Material', () => idOptions(this.registry.floorMaterials.map((rule) => rule.id)), patch, 'floorMaterialId', actionName),
      ...this.numberFields(RECT_FIELDS, patch, actionName),
    ]);
  }

  private setRows(rows: DraftField[]): void {
    this.fields = rows;
    replaceChildren(
      this.body,
      rows.map((entry) => entry.row),
    );
  }

  /**
   * Discrete controls commit directly — each change is already one discrete undo step. `refresh`
   * re-reads the options and the value from the document, so an undo/redo that leaves the
   * selection unchanged still updates the control, and a list that depends on another field (a
   * target door on its target sector) follows it.
   */
  private picker<K extends string>(
    label: string,
    options: (sector: Sector) => readonly PickerOption[],
    find: Find<Record<K, string>>,
    key: K,
    actionName: string,
  ): DraftField {
    const picker = select(label, []);
    let current: string | undefined;
    let listed = '';
    picker.input.addEventListener('change', () => {
      const value = picker.input.value;
      if (value === current) return;
      const { accepted } = this.callbacks.mutate(actionName, (draft) => {
        const record = find(draft);
        if (record !== undefined) record[key] = value;
      });
      if (!accepted && current !== undefined) setSelectValue(picker.input, current);
    });
    return {
      row: picker.row,
      refresh: (sector) => {
        const list = options(sector);
        const value = find(sector)?.[key] ?? '';
        if (JSON.stringify(list) !== listed) {
          replaceChildren(
            picker.input,
            list.map((option) => element('option', { text: option.label, attributes: { value: option.value } })),
          );
          listed = JSON.stringify(list);
          current = undefined;
        }
        if (value === current) return;
        setSelectValue(picker.input, value);
        current = value;
      },
    };
  }

  /**
   * A number of the record `find` names, under `key`. Lengths round to the millimetre; a field
   * that is not a length passes its own `normalize`.
   */
  private numberField<K extends string>(
    label: string,
    find: Find<Record<K, number>>,
    key: K,
    actionName: string,
    normalize: (value: number) => number = millimetres,
  ): DraftField {
    return this.draftField(
      label,
      (sector) => String(find(sector)?.[key] ?? 0),
      (text) => {
        // An emptied field reverts rather than coercing to 0 (`Number('')` is 0).
        if (text.trim() === '') return undefined;
        const value = Number(text);
        return Number.isFinite(value) ? String(normalize(value)) : undefined;
      },
      (rendered) =>
        this.callbacks.mutate(actionName, (draft) => {
          const record = find(draft);
          if (record !== undefined) record[key] = Number(rendered);
        }).accepted,
    );
  }

  private numberFields<K extends string>(fields: readonly (readonly [string, K])[], find: Find<Record<K, number>>, actionName: string): DraftField[] {
    return fields.map(([label, key]) => this.numberField(label, find, key, actionName));
  }

  private textField<K extends string>(label: string, find: Find<Record<K, string>>, key: K, actionName: string): DraftField {
    return this.draftField(
      label,
      (sector) => find(sector)?.[key] ?? '',
      (text) => text,
      (rendered) =>
        this.callbacks.mutate(actionName, (draft) => {
          const record = find(draft);
          if (record !== undefined) record[key] = rendered;
        }).accepted,
    );
  }

  /** The record's id, held to the rule the sector codec applies. A rename changes the selection's identity, so it goes through its own callback. */
  private idField(selection: EditorSelection): DraftField {
    return this.draftField(
      'Id',
      () => selection.id,
      (text) => (isValidId(text.trim()) ? text.trim() : undefined),
      (rendered) => this.callbacks.rename(selection, rendered),
    );
  }

  /**
   * The doors in a placement's wall: one button per door to select it, and one per free anchor
   * of its model to put a door there.
   */
  private doorList(placementId: string): DraftField {
    const row = element('div', { className: 'editor-door-list' });
    let listed = '';
    return {
      row,
      refresh: (sector) => {
        const doors = sector.doors.filter((door) => door.placement === placementId);
        const free = (objectModel(this.registry, byId(sector.placements, placementId)?.modelId ?? '')?.doors ?? [])
          .map((anchor) => anchor.id)
          .filter((anchor) => !doors.some((door) => door.anchor === anchor));
        const list = JSON.stringify([doors.map((door) => door.id), free]);
        if (list === listed) return;
        listed = list;
        replaceChildren(row, [
          ...doors.map((door) => button(`Door ${door.id}`, () => this.callbacks.onSelect({ kind: 'door', id: door.id }))),
          ...free.map((anchor) => button(`Add door at ${anchor}`, () => this.callbacks.onAddDoor(placementId, anchor))),
        ]);
      },
    };
  }

  /** What the world reports about the selected record, kept current as the document changes. */
  private issueLines(selection: EditorSelection): DraftField {
    const row = element('div');
    return {
      row,
      refresh: () => {
        const issues = this.callbacks.issues().records.filter((issue) => issue.record === selection.kind && issue.id === selection.id);
        replaceChildren(
          row,
          issues.map((issue) => issueLine(issue.message)),
        );
      },
    };
  }

  /** The multi-line dialog-script variant, same lifecycle minus the parse step. */
  private scriptField(id: string, find: Find<{ dialogScript: string }>, actionName: string): DraftField {
    const textarea = element('textarea', { className: 'fantasy-field editor-script-field' });
    textarea.id = `somnio-editor-script-${id}`;
    const { commit, refresh } = draft(
      textarea,
      (sector) => find(sector)?.dialogScript ?? '',
      (text) => text,
      (rendered) =>
        this.callbacks.mutate(actionName, (mutable) => {
          const npc = find(mutable);
          if (npc !== undefined) npc.dialogScript = rendered;
        }).accepted,
    );
    // Return submits like any text field; Shift-Return inserts the newline the script needs.
    textarea.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey) return;
      event.preventDefault();
      commit();
      textarea.blur();
    });
    const row = element('div', {
      children: [
        element('label', {
          className: 'editor-summary-label',
          text: 'Script',
          attributes: { for: textarea.id },
        }),
        textarea,
        element('p', {
          className: 'editor-caption',
          text: "Script syntax: --- separates dialog steps; $name substitutes the player's nickname at runtime.",
        }),
      ],
    });
    return { row, refresh };
  }

  /** A draft-backed text row, committed on Return and on blur. */
  private draftField(
    label: string,
    render: (sector: Sector) => string,
    parse: (text: string) => string | undefined,
    commitRendered: (rendered: string) => boolean,
  ): DraftField {
    // Through `field()` for the `<label for>`/`id` pairing — the editor's DOM UI exists so
    // `agent-browser snapshot` and screen readers can name every control.
    const { row, input } = field(label);
    const { commit, refresh } = draft(input, render, parse, commitRendered);
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      commit();
    });
    return { row, refresh };
  }
}

/**
 * The draft lifecycle of a text control: `commit`, which also runs when the control is blurred,
 * and the `refresh` that reseeds it from the document. `parse` returns the value's canonical
 * rendering (or `undefined` to revert); the commit fires only when the parsed rendering differs
 * from the committed one, and a commit the document refuses reverts too.
 */
function draft(
  control: HTMLInputElement | HTMLTextAreaElement,
  render: (sector: Sector) => string,
  parse: (text: string) => string | undefined,
  commitRendered: (rendered: string) => boolean,
): { commit: () => void; refresh: (sector: Sector) => void } {
  let lastRendered = '';
  const commit = (): void => {
    const parsed = parse(control.value);
    const committed = lastRendered;
    // Recorded before the commit runs: a rename has the rows replaced while it is still running,
    // Chromium blurs the focused input it removes, and that blur must find nothing left to commit.
    if (parsed !== undefined) lastRendered = parsed;
    if (parsed === undefined || (parsed !== committed && !commitRendered(parsed))) {
      lastRendered = committed;
      control.value = committed;
      return;
    }
    control.value = parsed;
  };
  control.addEventListener('blur', commit);
  return {
    commit,
    refresh: (sector) => {
      const to = render(sector);
      const seeded = reseeded(control.value, globalThis.document.activeElement === control, lastRendered, to);
      if (seeded !== undefined) control.value = seeded;
      lastRendered = to;
    },
  };
}

function issueLine(message: string): HTMLElement {
  return element('p', { className: 'editor-caption editor-issue', text: message });
}
