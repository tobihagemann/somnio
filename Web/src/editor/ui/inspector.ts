import { INT16_MAX, INT16_MIN } from '@/core/geometry'
import { heading } from '@/core/heading'
import { formatSwiftFloat32 } from '@/core/float'
import type { Sector } from '@/core/sector'
import { PORTAL_DIRECTIONS } from '@/core/sector'
import type { PortalDirection } from '@/core/sector'
import { button, element, field, replaceChildren, select, setSelectValue } from '@/ui/dom'
import { reseeded } from './inspectorDraft'
import { selectionBounds, selectionKey } from '../selection'
import type { EditorSelection } from '../selection'

/**
 * The persistent live inspector (top-trailing, 300px) editing the selected record's fields in
 * place. No selection shows the
 * sector-level summary; a multi-selection shows the count plus Delete; a single selection
 * edits every persisted field of its kind — direct placement seeds defaults, so this panel
 * is the only way to refine them.
 *
 * Text fields follow the draft lifecycle (`inspectorDraft.ts`): commit on Return or blur,
 * never per keystroke, so each committed edit is exactly one undo step and one scene
 * reconcile; an unparseable draft reverts, an equal value skips the commit. Rows are rebuilt
 * only when the selection identity changes — on a document change with the same selection,
 * each field refreshes through the reseed rule so a focused edit is never lost.
 */

export interface InspectorCallbacks {
  mutate(actionName: string, change: (sector: Sector) => void): void
  onDeleteSelection(): void
  onOpenSectorSettings(): void
}

interface DraftField {
  row: HTMLElement
  refresh(sector: Sector): void
}

export class InspectorPanel {
  readonly root: HTMLElement

  private readonly callbacks: InspectorCallbacks
  private readonly objectModelIDs: readonly string[]
  private readonly floorMaterialIDs: readonly string[]
  private readonly title: HTMLElement
  private readonly body: HTMLElement
  private fields: DraftField[] = []
  /** Selection identity of the currently built rows, so a reseed never hits foreign fields. */
  private renderedKey = ''

  constructor(
    callbacks: InspectorCallbacks,
    registry: { objectModelIDs: readonly string[]; floorMaterialIDs: readonly string[] }
  ) {
    this.callbacks = callbacks
    this.objectModelIDs = registry.objectModelIDs
    this.floorMaterialIDs = registry.floorMaterialIDs
    this.title = element('h1', { className: 'overlay-title', text: 'Sector' })
    this.body = element('div')
    this.root = element('div', {
      className: 'fantasy-panel editor-inspector',
      children: [this.title, this.body],
    })
  }

  render(sector: Sector, selection: readonly EditorSelection[], isUninitialized: boolean): void {
    const key = selection.length === 0 ? 'sector' : selection.map(selectionKey).sort().join(',')
    if (key === this.renderedKey) {
      for (const draftField of this.fields) draftField.refresh(sector)
      if (selection.length === 0) this.rebuild(sector, selection, isUninitialized, key)
      return
    }
    this.rebuild(sector, selection, isUninitialized, key)
  }

  private rebuild(
    sector: Sector,
    selection: readonly EditorSelection[],
    isUninitialized: boolean,
    key: string
  ): void {
    this.renderedKey = key
    this.fields = []
    if (selection.length === 0) {
      this.title.textContent = 'Sector'
      this.renderSectorSummary(sector, isUninitialized)
      return
    }
    if (selection.length > 1) {
      this.title.textContent = 'Selection'
      replaceChildren(this.body, [
        element('p', { text: `${selection.length} selected` }),
        button('Delete', () => this.callbacks.onDeleteSelection()),
      ])
      return
    }
    const selected = selection[0]!
    if (selectionBounds(selected, sector) === undefined) {
      replaceChildren(this.body, [])
      return
    }
    switch (selected.kind) {
      case 'object':
        this.title.textContent = 'Object'
        this.renderObject(sector, selected.index)
        break
      case 'mask':
        this.title.textContent = 'Mask'
        this.renderMask(sector, selected.index)
        break
      case 'portal':
        this.title.textContent = 'Sector portal'
        this.renderPortal(sector, selected.index)
        break
      case 'npc':
        this.title.textContent = 'NPC'
        this.renderNPC(sector, selected.index)
        break
      case 'monsterSpawn':
        this.title.textContent = 'Monster'
        this.renderMonster(sector, selected.index)
        break
      case 'floorPatch':
        this.title.textContent = 'Floor patch'
        this.renderFloorPatch(sector, selected.index)
        break
    }
  }

  // MARK: - Sector summary (no selection)

  private renderSectorSummary(sector: Sector, isUninitialized: boolean): void {
    const row = (label: string, value: string): HTMLElement =>
      element('div', {
        className: 'editor-summary-row',
        children: [
          element('span', { className: 'editor-summary-label', text: label }),
          element('span', { className: 'editor-summary-value', text: value }),
        ],
      })
    const settings = button('Sector Settings...', () => this.callbacks.onOpenSectorSettings())
    settings.disabled = isUninitialized
    replaceChildren(this.body, [
      row('Sector name', sector.name),
      row('Width', String(sector.dimensions.width)),
      row('Height', String(sector.dimensions.height)),
      row('Floor material', sector.floorMaterialID),
      row('Light', String(sector.light.brightness)),
      settings,
    ])
  }

  // MARK: - Per-kind fields

  private renderObject(sector: Sector, index: number): void {
    const actionName = 'Edit object'
    this.setRows(sector, [
      this.idPicker(
        'Model',
        this.objectModelIDs,
        (s) => s.objects[index]?.modelID ?? '',
        actionName,
        (draft, value) => {
          const object = draft.objects[index]
          if (object !== undefined) object.modelID = value
        }
      ),
      this.int16Field(
        'X',
        (s) => s.objects[index]?.x,
        actionName,
        (o, v) => (o.objects[index]!.x = v)
      ),
      this.int16Field(
        'Y',
        (s) => s.objects[index]?.y,
        actionName,
        (o, v) => (o.objects[index]!.y = v)
      ),
      this.int16Field(
        'Width',
        (s) => s.objects[index]?.sourceWidth,
        actionName,
        (o, v) => (o.objects[index]!.sourceWidth = v)
      ),
      this.int16Field(
        'Height',
        (s) => s.objects[index]?.sourceHeight,
        actionName,
        (o, v) => (o.objects[index]!.sourceHeight = v)
      ),
      this.int16Field(
        'Priority',
        (s) => s.objects[index]?.priority,
        actionName,
        (o, v) => (o.objects[index]!.priority = v)
      ),
      this.int16Field(
        'Rotation',
        (s) => s.objects[index]?.rotation,
        actionName,
        (o, v) => (o.objects[index]!.rotation = v)
      ),
    ])
  }

  private renderMask(sector: Sector, index: number): void {
    const actionName = 'Edit collision mask'
    this.setRows(sector, [
      this.int16Field(
        'X',
        (s) => s.collisionMasks[index]?.x,
        actionName,
        (o, v) => (o.collisionMasks[index]!.x = v)
      ),
      this.int16Field(
        'Y',
        (s) => s.collisionMasks[index]?.y,
        actionName,
        (o, v) => (o.collisionMasks[index]!.y = v)
      ),
      this.int16Field(
        'Width',
        (s) => s.collisionMasks[index]?.width,
        actionName,
        (o, v) => (o.collisionMasks[index]!.width = v)
      ),
      this.int16Field(
        'Height',
        (s) => s.collisionMasks[index]?.height,
        actionName,
        (o, v) => (o.collisionMasks[index]!.height = v)
      ),
    ])
  }

  private renderPortal(sector: Sector, index: number): void {
    const actionName = 'Edit sector portal'
    this.setRows(sector, [
      this.int16Field(
        'X',
        (s) => s.portals[index]?.x,
        actionName,
        (o, v) => (o.portals[index]!.x = v)
      ),
      this.int16Field(
        'Y',
        (s) => s.portals[index]?.y,
        actionName,
        (o, v) => (o.portals[index]!.y = v)
      ),
      this.int16Field(
        'Width',
        (s) => s.portals[index]?.width,
        actionName,
        (o, v) => (o.portals[index]!.width = v)
      ),
      this.int16Field(
        'Height',
        (s) => s.portals[index]?.height,
        actionName,
        (o, v) => (o.portals[index]!.height = v)
      ),
      this.stringField(
        'Target sector',
        (s) => s.portals[index]?.targetSectorName,
        actionName,
        (o, v) => (o.portals[index]!.targetSectorName = v)
      ),
      this.picker(
        'Direction',
        [
          { value: 'outboundTrigger', label: 'Outbound trigger' },
          { value: 'arrivalPlacement', label: 'Arrival placement' },
        ],
        (s) => s.portals[index]?.direction ?? 'outboundTrigger',
        actionName,
        (draft, value) => {
          const portal = draft.portals[index]
          if (portal !== undefined && value in PORTAL_DIRECTIONS) portal.direction = value as PortalDirection
        }
      ),
    ])
  }

  private renderNPC(sector: Sector, index: number): void {
    const actionName = 'Edit NPC'
    this.setRows(sector, [
      this.stringField(
        'Name',
        (s) => s.npcs[index]?.name,
        actionName,
        (o, v) => (o.npcs[index]!.name = v)
      ),
      this.int16Field(
        'Figure',
        (s) => s.npcs[index]?.figure,
        actionName,
        (o, v) => (o.npcs[index]!.figure = v)
      ),
      this.int16Field(
        'X',
        (s) => s.npcs[index]?.spawnOrigin.x,
        actionName,
        (o, v) => (o.npcs[index]!.spawnOrigin.x = v)
      ),
      this.int16Field(
        'Y',
        (s) => s.npcs[index]?.spawnOrigin.y,
        actionName,
        (o, v) => (o.npcs[index]!.spawnOrigin.y = v)
      ),
      this.int16Field(
        'Box width',
        (s) => s.npcs[index]?.spawnBoxSize.width,
        actionName,
        (o, v) => (o.npcs[index]!.spawnBoxSize.width = v)
      ),
      this.int16Field(
        'Box height',
        (s) => s.npcs[index]?.spawnBoxSize.height,
        actionName,
        (o, v) => (o.npcs[index]!.spawnBoxSize.height = v)
      ),
      this.int16Field(
        'Mask width',
        (s) => s.npcs[index]?.maskSize.width,
        actionName,
        (o, v) => (o.npcs[index]!.maskSize.width = v)
      ),
      this.int16Field(
        'Mask height',
        (s) => s.npcs[index]?.maskSize.height,
        actionName,
        (o, v) => (o.npcs[index]!.maskSize.height = v)
      ),
      this.facingField(index),
      this.int16Field(
        'Behavior',
        (s) => s.npcs[index]?.behaviorTag,
        actionName,
        (o, v) => (o.npcs[index]!.behaviorTag = v)
      ),
      caption('Only behaviorTag 0 (greeter) is implemented server-side; other values fall through.'),
      this.scriptField(index, sector),
    ])
  }

  private renderMonster(sector: Sector, index: number): void {
    const actionName = 'Edit monster spawn'
    this.setRows(sector, [
      this.stringField(
        'Name',
        (s) => s.monsterSpawns[index]?.name,
        actionName,
        (o, v) => (o.monsterSpawns[index]!.name = v)
      ),
      this.int16Field(
        'Figure',
        (s) => s.monsterSpawns[index]?.figure,
        actionName,
        (o, v) => (o.monsterSpawns[index]!.figure = v)
      ),
      this.int16Field(
        'X',
        (s) => s.monsterSpawns[index]?.spawnOrigin.x,
        actionName,
        (o, v) => (o.monsterSpawns[index]!.spawnOrigin.x = v)
      ),
      this.int16Field(
        'Y',
        (s) => s.monsterSpawns[index]?.spawnOrigin.y,
        actionName,
        (o, v) => (o.monsterSpawns[index]!.spawnOrigin.y = v)
      ),
      this.int16Field(
        'Box width',
        (s) => s.monsterSpawns[index]?.spawnBoxSize.width,
        actionName,
        (o, v) => (o.monsterSpawns[index]!.spawnBoxSize.width = v)
      ),
      this.int16Field(
        'Box height',
        (s) => s.monsterSpawns[index]?.spawnBoxSize.height,
        actionName,
        (o, v) => (o.monsterSpawns[index]!.spawnBoxSize.height = v)
      ),
      this.int16Field(
        'Monster width',
        (s) => s.monsterSpawns[index]?.spawnedMonsterSize.width,
        actionName,
        (o, v) => (o.monsterSpawns[index]!.spawnedMonsterSize.width = v)
      ),
      this.int16Field(
        'Monster height',
        (s) => s.monsterSpawns[index]?.spawnedMonsterSize.height,
        actionName,
        (o, v) => (o.monsterSpawns[index]!.spawnedMonsterSize.height = v)
      ),
      this.picker(
        'Bounded',
        [
          { value: 'true', label: 'Yes' },
          { value: 'false', label: 'No' },
        ],
        (s) => String(s.monsterSpawns[index]?.bounded ?? true),
        actionName,
        (draft, value) => {
          const spawn = draft.monsterSpawns[index]
          if (spawn !== undefined) spawn.bounded = value === 'true'
        }
      ),
      this.int16Field(
        'Spawn HP',
        (s) => s.monsterSpawns[index]?.spawnHP,
        actionName,
        (o, v) => (o.monsterSpawns[index]!.spawnHP = v)
      ),
      this.int16Field(
        'Spawn balance',
        (s) => s.monsterSpawns[index]?.spawnBalance,
        actionName,
        (o, v) => (o.monsterSpawns[index]!.spawnBalance = v)
      ),
      this.int16Field(
        'Spawn mana',
        (s) => s.monsterSpawns[index]?.spawnMana,
        actionName,
        (o, v) => (o.monsterSpawns[index]!.spawnMana = v)
      ),
      this.int16Field(
        'Script index',
        (s) => s.monsterSpawns[index]?.aiScriptIndex,
        actionName,
        (o, v) => (o.monsterSpawns[index]!.aiScriptIndex = v)
      ),
    ])
  }

  private renderFloorPatch(sector: Sector, index: number): void {
    const actionName = 'Edit floor patch'
    this.setRows(sector, [
      this.idPicker(
        'Material',
        this.floorMaterialIDs,
        (s) => s.floorPatches[index]?.floorMaterialID ?? '',
        actionName,
        (draft, value) => {
          const patch = draft.floorPatches[index]
          if (patch !== undefined) patch.floorMaterialID = value
        }
      ),
      this.int16Field(
        'X',
        (s) => s.floorPatches[index]?.x,
        actionName,
        (o, v) => (o.floorPatches[index]!.x = v)
      ),
      this.int16Field(
        'Y',
        (s) => s.floorPatches[index]?.y,
        actionName,
        (o, v) => (o.floorPatches[index]!.y = v)
      ),
      this.int16Field(
        'Width',
        (s) => s.floorPatches[index]?.width,
        actionName,
        (o, v) => (o.floorPatches[index]!.width = v)
      ),
      this.int16Field(
        'Height',
        (s) => s.floorPatches[index]?.height,
        actionName,
        (o, v) => (o.floorPatches[index]!.height = v)
      ),
    ])
  }

  // MARK: - Field construction

  private setRows(sector: Sector, rows: DraftField[]): void {
    this.fields = rows
    replaceChildren(
      this.body,
      rows.map((entry) => entry.row)
    )
    // Seed every draft from the live document; nothing is focused at build time, so the
    // reseed rule fills each field with its committed rendering.
    for (const entry of rows) entry.refresh(sector)
  }

  /**
   * Discrete controls commit directly — each change is already one discrete undo step. `refresh`
   * re-reads the value from the document so an undo/redo that leaves the selection unchanged still
   * updates the control (a no-op refresh would leave it showing the discarded value).
   */
  private picker(
    label: string,
    options: readonly { value: string; label: string }[],
    read: (sector: Sector) => string,
    actionName: string,
    commit: (sector: Sector, value: string) => void
  ): DraftField {
    const picker = select(label, options)
    let current = ''
    picker.input.addEventListener('change', () => {
      const value = picker.input.value
      if (value === current) return
      this.callbacks.mutate(actionName, (draft) => commit(draft, value))
      current = value
    })
    return {
      row: picker.row,
      refresh: (sector) => {
        const value = read(sector)
        if (value === current) return
        setSelectValue(picker.input, value)
        current = value
      },
    }
  }

  /** A picker over registry ids (`id` is both the option value and its label). */
  private idPicker(
    label: string,
    ids: readonly string[],
    read: (sector: Sector) => string,
    actionName: string,
    commit: (sector: Sector, value: string) => void
  ): DraftField {
    return this.picker(
      label,
      ids.map((id) => ({ value: id, label: id })),
      read,
      actionName,
      commit
    )
  }

  private int16Field(
    label: string,
    read: (sector: Sector) => number | undefined,
    actionName: string,
    write: (sector: Sector, value: number) => void
  ): DraftField {
    return this.draftField(
      label,
      (sector) => String(read(sector) ?? 0),
      (text) => {
        // Mirror `Int16(_: String)`: an empty, whitespace, hex, or exponent draft has no integer
        // value, so it reverts to the committed rendering rather than coercing (`Number('')` is 0).
        const trimmed = text.trim()
        if (!/^[+-]?\d+$/.test(trimmed)) return undefined
        const value = Number(trimmed)
        if (value < INT16_MIN || value > INT16_MAX) return undefined
        return String(value)
      },
      (rendered) => {
        this.callbacks.mutate(actionName, (draft) => write(draft, Number(rendered)))
      }
    )
  }

  private stringField(
    label: string,
    read: (sector: Sector) => string | undefined,
    actionName: string,
    write: (sector: Sector, value: string) => void
  ): DraftField {
    return this.draftField(
      label,
      (sector) => read(sector) ?? '',
      (text) => text,
      (rendered) => {
        this.callbacks.mutate(actionName, (draft) => write(draft, rendered))
      }
    )
  }

  /** Facing renders and parses through the heading's normalization, so `-90` commits as 270. */
  private facingField(index: number): DraftField {
    return this.draftField(
      'Facing',
      (sector) => formatSwiftFloat32(sector.npcs[index]?.facing ?? 0),
      (text) => {
        // An emptied field reverts rather than coercing to heading 0 (`Number('')` is 0).
        if (text.trim() === '') return undefined
        const value = Number(text)
        if (!Number.isFinite(value)) return undefined
        return formatSwiftFloat32(heading(value))
      },
      (rendered) => {
        this.callbacks.mutate('Edit NPC', (draft) => {
          const npc = draft.npcs[index]
          if (npc !== undefined) npc.facing = heading(Number(rendered))
        })
      }
    )
  }

  /** The multi-line dialog-script variant, same lifecycle minus the parse step. */
  private scriptField(index: number, sector: Sector): DraftField {
    const textarea = element('textarea', { className: 'fantasy-field editor-script-field' })
    textarea.id = `somnio-editor-script-${index}`
    textarea.value = sector.npcs[index]?.dialogScript ?? ''
    let lastRendered = textarea.value
    const commit = (): void => {
      const draft = textarea.value
      if (draft !== lastRendered) {
        this.callbacks.mutate('Edit NPC', (mutable) => {
          const npc = mutable.npcs[index]
          if (npc !== undefined) npc.dialogScript = draft
        })
        lastRendered = draft
      }
    }
    // Return submits like any text field; Shift-Return inserts the newline the script needs.
    textarea.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey) return
      event.preventDefault()
      commit()
      textarea.blur()
    })
    textarea.addEventListener('blur', commit)
    const row = element('div', {
      children: [
        element('label', {
          className: 'editor-summary-label',
          text: 'Script',
          attributes: { for: textarea.id },
        }),
        textarea,
        caption(
          "Script syntax: --- separates dialog steps; $name substitutes the player's nickname at runtime."
        ).row,
      ],
    })
    return {
      row,
      refresh: (current) => {
        const to = current.npcs[index]?.dialogScript ?? ''
        const seeded = reseeded(
          textarea.value,
          globalThis.document.activeElement === textarea,
          lastRendered,
          to
        )
        if (seeded !== undefined) textarea.value = seeded
        lastRendered = to
      },
    }
  }

  /**
   * A draft-backed text row. `parse` returns the value's canonical rendering (or `undefined`
   * to revert); commit fires only when the parsed rendering differs from the committed one.
   */
  private draftField(
    label: string,
    render: (sector: Sector) => string,
    parse: (text: string) => string | undefined,
    commitRendered: (rendered: string) => void
  ): DraftField {
    // Through `field()` for the `<label for>`/`id` pairing — the editor's DOM UI exists so
    // `agent-browser snapshot` and screen readers can name every control.
    const { row, input } = field(label)
    let lastRendered = ''
    const commit = (): void => {
      const parsed = parse(input.value)
      if (parsed === undefined) {
        input.value = lastRendered
        return
      }
      if (parsed !== lastRendered) {
        commitRendered(parsed)
        lastRendered = parsed
      }
      input.value = parsed
    }
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      commit()
    })
    input.addEventListener('blur', commit)
    return {
      row,
      refresh: (sector) => {
        const to = render(sector)
        const seeded = reseeded(input.value, globalThis.document.activeElement === input, lastRendered, to)
        if (seeded !== undefined) input.value = seeded
        lastRendered = to
      },
    }
  }
}

function caption(text: string): { row: HTMLElement; refresh: () => void } {
  return { row: element('p', { className: 'editor-caption', text }), refresh: () => {} }
}
