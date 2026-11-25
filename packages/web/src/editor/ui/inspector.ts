import { MONSTER_KIND_IDS, QUEST_IDS, QUEST_STANDINGS, SOMNIO_CONSTANTS, clamp, heading, listenerRolesFor, objectModel } from '@somnio/core';
import type { DialogCondition, DialogStep, ListenerRole, ModelRegistry, Sector } from '@somnio/core';
import { SERVICES } from '@somnio/protocol';
import type { Service } from '@somnio/protocol';
import { GROUND_MATERIAL_IDS } from '@/scene/groundMaterials';
import { button, checkbox, element, endsLine, field, replaceChildren, select, setOptions } from '@/ui/dom';
import { maxStrokeRadius } from '../groundMarks';
import { millimetres } from '../preferences';
import { byId, isValidId, isValidSelection, selectionKey, setFixtureService } from '../selection';
import type { EditorSelection, RecordRename } from '../selection';
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
 * skips the commit. Rows are rebuilt only when the selection identity changes. A rename of the
 * shown record keeps them, since each field finds its record through the rows' holder, which the
 * rename moves (`followRename`). On a document change with the same selection, each field
 * refreshes through the reseed rule so a focused edit is never lost. An NPC's dialog is the one
 * field whose own rows follow the document, rebuilt as its step count, or the roles its steps may
 * be for, change.
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

/** An option of a picker that writes a value of its own, which may be none. */
interface ChoiceOption<V> extends PickerOption {
  choice: V;
}

/** Whom a step is for, as its For picker offers it. */
type ListenerOption = ChoiceOption<DialogCondition | undefined>;

/** What an NPC's New step box holds that is not added yet: its text, and its For as the option's value. */
interface UnaddedStep {
  text: string;
  listener: string;
}

/** Finds the record a field edits in whichever body it is handed: the live one to read, a commit's copy to write. */
type Find<R> = (sector: Sector) => R | undefined;

/** The single record a set of rows edits. A rename puts the renamed selection in its place, so the rows read the id as they run. */
interface RecordHolder {
  record: EditorSelection;
}

const POSITION_FIELDS = [
  ['X', 'x'],
  ['Z', 'z'],
] as const;

const RECT_FIELDS = [...POSITION_FIELDS, ['Width', 'width'], ['Depth', 'depth']] as const;

const SERVICE_LABELS: Record<Service, string> = {
  fighterMaster: 'Fighter master',
  healerMaster: 'Healer master',
  mysticMaster: 'Mystic master',
  shopkeeper: 'Shopkeeper',
  bountyBoard: 'Bounty board',
};

const LISTENER_ROLE_LABELS: Record<ListenerRole, string> = {
  none: 'No role',
  own: 'Own role',
  other: 'Another role',
};

/** The identity of the rows a selection shows, which the rows are rebuilt on a change of. */
function rowsKey(selection: readonly EditorSelection[]): string {
  return selection.length === 0 ? 'sector' : selection.map(selectionKey).sort().join(',');
}

function idOptions(ids: readonly string[]): PickerOption[] {
  return ids.map((id) => ({ value: id, label: id }));
}

/** A share from 0 to 1, to the hundredth. */
function unitShare(value: number): number {
  return Math.round(clamp(value, 0, 1) * 100) / 100;
}

export class InspectorPanel {
  readonly root: HTMLElement;

  private readonly callbacks: InspectorCallbacks;
  private readonly registry: ModelRegistry;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;
  private fields: DraftField[] = [];
  /** The document as last rendered, which a field's bounds are read from. */
  private shown!: Sector;
  /** Selection identity of the currently built rows, so a reseed never hits foreign fields. */
  private renderedKey = '';
  /** What the rows edit while one record is shown. */
  private holder: RecordHolder | undefined;
  /**
   * Each NPC's New step box as last left, by the NPC's id, so selecting another loses no line. An
   * entry follows its NPC's renames (`followRename`) and goes with the NPC and with the document
   * (`forgetUnaddedSteps`), so no other NPC that later holds the id finds it.
   */
  private readonly unaddedSteps = new Map<string, UnaddedStep>();

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

  /**
   * Carries the rows, and an NPC's unadded step, along with a rename of their record: a commit's,
   * an undo's, or a redo's. The next render keeps the rows, so a press whose blur committed the
   * rename still lands on the control it was aimed at.
   */
  followRename(rename: RecordRename): void {
    if (this.holder !== undefined && selectionKey(this.holder.record) === selectionKey(rename.from)) {
      this.holder.record = rename.to;
      this.renderedKey = rowsKey([rename.to]);
    }
    if (rename.from.kind !== 'npc') return;
    const kept = this.unaddedSteps.get(rename.from.id);
    if (kept === undefined) return;
    this.unaddedSteps.delete(rename.from.id);
    this.unaddedSteps.set(rename.to.id, kept);
  }

  /** Drops every NPC's unadded step, for a document that replaces this one. */
  forgetUnaddedSteps(): void {
    this.unaddedSteps.clear();
  }

  render(sector: Sector, selection: readonly EditorSelection[], isUninitialized: boolean): void {
    this.shown = sector;
    for (const id of this.unaddedSteps.keys()) if (!sector.npcs.some((npc) => npc.id === id)) this.unaddedSteps.delete(id);
    const key = rowsKey(selection);
    if (key !== this.renderedKey || selection.length === 0) this.rebuild(sector, selection, isUninitialized, key);
    // Rows just built are seeded here too: nothing in them is focused, so the reseed rule fills
    // each field with its committed rendering.
    for (const draftField of this.fields) draftField.refresh(sector);
  }

  private rebuild(sector: Sector, selection: readonly EditorSelection[], isUninitialized: boolean, key: string): void {
    this.renderedKey = key;
    this.fields = [];
    this.holder = undefined;
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
    const holder: RecordHolder = { record: selected };
    this.holder = holder;
    switch (selected.kind) {
      case 'placement':
        this.title.textContent = 'Model';
        this.renderPlacement(holder);
        break;
      case 'blocker':
        this.title.textContent = 'Blocker';
        this.setRows([this.idField(holder), ...this.numberFields(RECT_FIELDS, (s) => byId(s.blockers, holder.record.id), 'Edit blocker')]);
        break;
      case 'door':
        this.title.textContent = 'Door';
        this.renderDoor(holder);
        break;
      case 'npc':
        this.title.textContent = 'NPC';
        this.renderNPC(holder);
        break;
      case 'monsterSpawn':
        this.title.textContent = 'Monster spawn';
        this.renderMonsterSpawn(holder);
        break;
      case 'mark':
        this.title.textContent = 'Ground mark';
        this.renderMark(holder);
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
      row('Ground material', sector.ground.backgroundMaterialId),
      ...issueMessages(this.callbacks.issues()).map(issueLine),
      settings,
    ]);
  }

  private renderPlacement(holder: RecordHolder): void {
    const actionName = 'Edit model';
    const placement: Find<Sector['placements'][number]> = (s) => byId(s.placements, holder.record.id);
    this.setRows([
      this.idField(holder),
      this.picker('Model', () => idOptions(this.registry.objectModels.map((rule) => rule.id)), placement, 'modelId', actionName),
      ...this.numberFields(POSITION_FIELDS, placement, actionName),
      this.numberField('Yaw', placement, 'yaw', actionName, heading),
      this.numberField('Elevation', placement, 'elevation', actionName),
      this.doorList(holder),
      this.servicePicker(
        (s) => s.fixtures.find((fixture) => fixture.placement === holder.record.id)?.service,
        actionName,
        (draft, service) => setFixtureService(draft, holder.record.id, service),
      ),
      this.issueLines(holder),
    ]);
  }

  private renderDoor(holder: RecordHolder): void {
    const actionName = 'Edit door';
    const door: Find<Sector['doors'][number]> = (s) => byId(s.doors, holder.record.id);
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
      this.idField(holder),
      this.picker('Anchor', (s) => idOptions(anchors(s)), door, 'anchor', actionName),
      this.picker(
        'Target sector',
        () => [{ value: '', label: '(none)' }, ...idOptions(this.callbacks.otherSectors().map((other) => other.name))],
        target,
        'sector',
        actionName,
      ),
      this.picker('Target door', (s) => idOptions(targetDoors(s)), target, 'door', actionName),
      this.nightOnlyToggle(door, actionName),
      this.issueLines(holder),
    ]);
  }

  private renderNPC(holder: RecordHolder): void {
    const actionName = 'Edit NPC';
    const npc: Find<Sector['npcs'][number]> = (s) => byId(s.npcs, holder.record.id);
    this.setRows([
      this.idField(holder),
      this.textField('Name', npc, 'name', actionName),
      this.picker('Character', () => idOptions(this.registry.characterModels.map((rule) => rule.id)), npc, 'characterModelId', actionName),
      ...this.numberFields(POSITION_FIELDS, npc, actionName),
      this.numberField('Facing', npc, 'facing', actionName, heading),
      this.servicePicker(
        (s) => npc(s)?.service,
        actionName,
        (draft, service) => {
          const record = npc(draft);
          if (record === undefined) return;
          if (service === undefined) delete record.service;
          else record.service = service;
        },
      ),
      this.greetingField(npc, actionName),
      this.dialogField(holder, npc, actionName),
    ]);
  }

  private renderMonsterSpawn(holder: RecordHolder): void {
    const actionName = 'Edit monster spawn';
    const spawn: Find<Sector['monsterSpawns'][number]> = (s) => byId(s.monsterSpawns, holder.record.id);
    this.setRows([
      this.idField(holder),
      this.picker('Kind', () => idOptions(MONSTER_KIND_IDS), spawn, 'kind', actionName),
      ...this.numberFields(RECT_FIELDS, spawn, actionName),
      this.numberField('Max alive', spawn, 'maxAlive', actionName, (value) => value),
      this.numberField('Elite chance', spawn, 'eliteChance', actionName, unitShare),
    ]);
  }

  /**
   * A mark's material, opacity, and, for a stroke, its radius. Its shape is repainted rather than
   * edited, and its points never move here, so a stroke's radius is capped where its points still
   * lie inside the bound the codec holds them to.
   */
  private renderMark(holder: RecordHolder): void {
    const actionName = 'Edit ground mark';
    const mark: Find<Sector['ground']['marks'][number]> = (s) => byId(s.ground.marks, holder.record.id);
    const stroke: Find<{ radius: number }> = (s) => {
      const shape = mark(s)?.shape;
      return shape?.kind === 'stroke' ? shape : undefined;
    };
    this.setRows([
      this.idField(holder),
      this.picker('Material', () => idOptions(GROUND_MATERIAL_IDS), mark, 'materialId', actionName),
      this.numberField('Opacity', mark, 'opacity', actionName, unitShare),
      ...(stroke(this.shown) === undefined
        ? []
        : [
            this.numberField('Radius', stroke, 'radius', actionName, (value) =>
              millimetres(Math.min(Math.max(value, 0), maxStrokeRadius(this.shown.size, mark(this.shown)?.shape.points ?? []))),
            ),
          ]),
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
          setOptions(picker.input, list);
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
   * What a carrier offers: an NPC's service, or the fixture a placement carries. None is
   * `undefined` to `apply`, which removes what the record held rather than writing an empty value.
   */
  private servicePicker(
    current: (sector: Sector) => Service | undefined,
    actionName: string,
    apply: (draft: Sector, service: Service | undefined) => void,
  ): DraftField {
    return this.choicePicker(
      'Service',
      [{ value: '', label: 'None', choice: undefined }, ...SERVICES.map((service) => ({ value: service, label: SERVICE_LABELS[service], choice: service }))],
      (sector) => current(sector) ?? '',
      actionName,
      apply,
    );
  }

  /**
   * A picker whose options each write a value of their own, committed directly like `picker`.
   * `current` names the option the document holds, and a change the document refuses puts the
   * select back on it.
   */
  private choicePicker<V>(
    label: string,
    options: readonly ChoiceOption<V>[],
    current: (sector: Sector) => string,
    actionName: string,
    apply: (draft: Sector, choice: V) => void,
  ): DraftField {
    const picker = select(label, options);
    let shown = '';
    picker.input.addEventListener('change', () => {
      const option = options.find((candidate) => candidate.value === picker.input.value);
      if (option === undefined || option.value === shown) return;
      const { accepted } = this.callbacks.mutate(actionName, (draft) => apply(draft, option.choice));
      if (!accepted) setSelectValue(picker.input, shown);
    });
    return {
      row: picker.row,
      refresh: (sector) => {
        shown = current(sector);
        setSelectValue(picker.input, shown);
      },
    };
  }

  /** Whether the door opens only at night. Off removes the property, so a door open at every hour is saved without the key. */
  private nightOnlyToggle(find: Find<Sector['doors'][number]>, actionName: string): DraftField {
    const toggle = checkbox('Opens only at night', false);
    toggle.input.addEventListener('change', () => {
      const nightOnly = toggle.input.checked;
      const { accepted } = this.callbacks.mutate(actionName, (draft) => {
        const door = find(draft);
        if (door === undefined) return;
        if (nightOnly) door.nightOnly = true;
        else delete door.nightOnly;
      });
      if (!accepted) toggle.input.checked = !nightOnly;
    });
    return {
      row: toggle.row,
      refresh: (sector) => {
        toggle.input.checked = find(sector)?.nightOnly === true;
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
  private idField(holder: RecordHolder): DraftField {
    return this.draftField(
      'Id',
      () => holder.record.id,
      (text) => (isValidId(text.trim()) ? text.trim() : undefined),
      (rendered) => this.callbacks.rename(holder.record, rendered),
    );
  }

  /**
   * The doors in a placement's wall: one button per door to select it, and one per free anchor
   * of its model to put a door there.
   */
  private doorList(holder: RecordHolder): DraftField {
    const row = element('div', { className: 'editor-door-list' });
    let listed = '';
    return {
      row,
      refresh: (sector) => {
        const doors = sector.doors.filter((door) => door.placement === holder.record.id);
        const free = (objectModel(this.registry, byId(sector.placements, holder.record.id)?.modelId ?? '')?.doors ?? [])
          .map((anchor) => anchor.id)
          .filter((anchor) => !doors.some((door) => door.anchor === anchor));
        const list = JSON.stringify([doors.map((door) => door.id), free]);
        if (list === listed) return;
        listed = list;
        replaceChildren(row, [
          ...doors.map((door) => button(`Door ${door.id}`, () => this.callbacks.onSelect({ kind: 'door', id: door.id }))),
          ...free.map((anchor) => button(`Add door at ${anchor}`, () => this.callbacks.onAddDoor(holder.record.id, anchor))),
        ]);
      },
    };
  }

  /** What the world reports about the selected record, kept current as the document changes. */
  private issueLines(holder: RecordHolder): DraftField {
    const row = element('div');
    return {
      row,
      refresh: () => {
        const issues = this.callbacks.issues().records.filter((issue) => issue.record === holder.record.kind && issue.id === holder.record.id);
        replaceChildren(
          row,
          issues.map((issue) => issueLine(issue.message)),
        );
      },
    };
  }

  /** What an NPC says to whoever comes near. Cleared to blank, it removes the greeting. */
  private greetingField(find: Find<Sector['npcs'][number]>, actionName: string): DraftField {
    return this.lineArea(
      'Greeting',
      'somnio-editor-greeting',
      (sector) => find(sector)?.greeting ?? '',
      (text) => (text.trim() === '' ? '' : text),
      (rendered) =>
        this.callbacks.mutate(actionName, (mutable) => {
          const npc = find(mutable);
          if (npc === undefined) return;
          if (rendered === '') delete npc.greeting;
          else npc.greeting = rendered;
        }).accepted,
    );
  }

  /**
   * The steps an NPC says when asked, a row each, and under them the New step box. Unlike a fixed
   * control, the rows follow the document. A refresh rebuilds them when the step count, or the
   * roles the NPC's steps may be for, change, and otherwise reseeds each. The box stands outside
   * the rows, so a rebuild keeps its text and only offers its For again. It writes nothing until
   * Add step or Enter adds its line, for whom its For names, as one undo step that empties it. A
   * line the document refuses stays in the box, and its For goes back to Everyone once the NPC's
   * service no longer offers it.
   */
  private dialogField(holder: RecordHolder, find: Find<Sector['npcs'][number]>, actionName: string): DraftField {
    const list = element('div');
    let rows: DraftField[] = [];
    let options: ListenerOption[] = [];
    let shape: string | undefined;
    const textarea = lineTextarea('somnio-editor-step-new');
    textarea.value = this.unaddedSteps.get(holder.record.id)?.text ?? '';
    const listener = select('For new step', []);
    const keep = (): void => {
      this.unaddedSteps.set(holder.record.id, { text: textarea.value, listener: listener.input.value });
    };
    textarea.addEventListener('input', keep);
    listener.input.addEventListener('change', keep);
    const add = (): void => {
      if (textarea.value.trim() === '') return;
      const step: DialogStep = { text: textarea.value };
      setListener(step, options.find((option) => option.value === listener.input.value)?.choice);
      if (!this.callbacks.mutate(actionName, (mutable) => find(mutable)?.dialog.push(step)).accepted) return;
      this.unaddedSteps.delete(holder.record.id);
      textarea.value = '';
      listener.input.value = '';
      textarea.focus();
    };
    textarea.addEventListener('keydown', (event) => {
      if (!endsLine(event)) return;
      event.preventDefault();
      add();
    });
    const row = element('div', {
      children: [
        element('div', { className: 'editor-summary-label', text: 'Dialog' }),
        list,
        element('div', { className: 'editor-dialog-step', children: [lineRow('New step', textarea), listener.row, button('Add step', add)] }),
        element('p', {
          className: 'editor-caption',
          text: `Add step or Enter adds the new step. $name substitutes the dreamer's name and counts as ${SOMNIO_CONSTANTS.npcDialogNameGraphemes} characters. A line runs at most ${SOMNIO_CONSTANTS.npcDialogLineGraphemes} characters.`,
        }),
      ],
    });
    return {
      row,
      refresh: (sector) => {
        const record = find(sector);
        const steps = record?.dialog ?? [];
        const next = `${steps.length} ${listenerRolesFor(record?.service).join(',')}`;
        if (next === shape) {
          for (const entry of rows) entry.refresh(sector);
          return;
        }
        shape = next;
        options = listenerOptions(record?.service);
        const chosen = this.unaddedSteps.get(holder.record.id)?.listener ?? '';
        setOptions(listener.input, options);
        listener.input.value = options.some((option) => option.value === chosen) ? chosen : '';
        if (listener.input.value !== chosen) keep();
        rows = steps.map((_, index) => this.dialogStepRow(find, index, options, actionName));
        replaceChildren(
          list,
          rows.map((entry) => entry.row),
        );
        for (const entry of rows) entry.refresh(sector);
      },
    };
  }

  /** One step of an NPC's dialog: its text, whom it is for, and Remove. */
  private dialogStepRow(find: Find<Sector['npcs'][number]>, index: number, options: readonly ListenerOption[], actionName: string): DraftField {
    const step = (sector: Sector) => find(sector)?.dialog[index];
    const text = this.lineArea(
      `Step ${index + 1}`,
      `somnio-editor-step-${index}`,
      (sector) => step(sector)?.text ?? '',
      (typed) => typed,
      (rendered) =>
        this.callbacks.mutate(actionName, (mutable) => {
          const record = step(mutable);
          if (record !== undefined) record.text = rendered;
        }).accepted,
    );
    const listener = this.choicePicker(
      `For step ${index + 1}`,
      options,
      (sector) => listenerValue(step(sector)?.when),
      actionName,
      (mutable, when) => {
        const record = step(mutable);
        if (record !== undefined) setListener(record, when);
      },
    );
    const remove = button('Remove', () => this.callbacks.mutate(actionName, (mutable) => find(mutable)?.dialog.splice(index, 1)));
    return {
      row: element('div', { className: 'editor-dialog-step', children: [text.row, listener.row, remove] }),
      refresh: (sector) => {
        text.refresh(sector);
        listener.refresh(sector);
      },
    };
  }

  /** A line an NPC says, draft-backed like a text field. Return commits it and leaves the field. */
  private lineArea(
    label: string,
    id: string,
    render: (sector: Sector) => string,
    parse: (text: string) => string | undefined,
    commitRendered: (rendered: string) => boolean,
  ): DraftField {
    const textarea = lineTextarea(id);
    const { commit, refresh } = draft(textarea, render, parse, commitRendered);
    textarea.addEventListener('keydown', (event) => {
      if (!endsLine(event)) return;
      event.preventDefault();
      commit();
      textarea.blur();
    });
    return { row: lineRow(label, textarea), refresh };
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
      if (!endsLine(event)) return;
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
    if (parsed === undefined || (parsed !== lastRendered && !commitRendered(parsed))) {
      control.value = lastRendered;
      return;
    }
    lastRendered = parsed;
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

function lineTextarea(id: string): HTMLTextAreaElement {
  const textarea = element('textarea', { className: 'fantasy-field editor-line-field' });
  textarea.id = id;
  return textarea;
}

function lineRow(label: string, textarea: HTMLTextAreaElement): HTMLElement {
  return element('div', {
    children: [element('label', { className: 'editor-summary-label', text: label, attributes: { for: textarea.id } }), textarea],
  });
}

/** Points a step at whom it is for; Everyone removes the key. */
function setListener(step: DialogStep, when: DialogCondition | undefined): void {
  if (when === undefined) delete step.when;
  else step.when = { ...when };
}

/** Everyone, each listener role the service allows, and each committed quest at each standing. */
function listenerOptions(service: Service | undefined): ListenerOption[] {
  const conditions: DialogCondition[] = [
    ...listenerRolesFor(service).map((role) => ({ role })),
    ...QUEST_IDS.flatMap((quest) => QUEST_STANDINGS.map((state) => ({ quest, state }))),
  ];
  return [
    { value: '', label: 'Everyone', choice: undefined },
    ...conditions.map((when) => ({
      value: listenerValue(when),
      label: 'role' in when ? LISTENER_ROLE_LABELS[when.role] : `${when.quest} ${when.state}`,
      choice: when,
    })),
  ];
}

function listenerValue(when: DialogCondition | undefined): string {
  if (when === undefined) return '';
  return 'role' in when ? `role:${when.role}` : `quest:${when.quest}:${when.state}`;
}

function issueLine(message: string): HTMLElement {
  return element('p', { className: 'editor-caption editor-issue', text: message });
}
