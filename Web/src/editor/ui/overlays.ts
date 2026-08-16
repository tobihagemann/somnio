import { button, card, element, field, replaceChildren, scrim, select, setHidden } from '@/ui/dom'
import { GRID_SNAP_PRESETS_PX } from '../preferences'
import type { GridSnapPx } from '../preferences'
import { SectorForm } from './sectorForm'
import type { SectorFormValues } from './sectorForm'

/**
 * The editor's overlay host, following `ui/overlays.ts`: every view built once into a record
 * keyed exhaustively over `EditorOverlayKind`, `.hidden` toggled in `present()`. `preferences`
 * is the only surface that ever changes the grid-snap preference — without it the editor snaps
 * to 32 forever; `sectorPicker` is the open/create list the file API makes possible; and
 * `saveAs` collects the new name the browser has no native File menu for.
 */

export type EditorOverlayKind =
  'gameMenu' | 'newMap' | 'sectorSettings' | 'about' | 'preferences' | 'sectorPicker' | 'saveAs'

export interface EditorOverlayCallbacks {
  onResume: () => void
  onShowOverlay: (kind: EditorOverlayKind) => void
  onSave: () => void
  onSaveAs: (name: string) => void
  onCommitNewMap: (values: SectorFormValues) => void
  onCancelNewMap: () => void
  onApplySectorSettings: (values: SectorFormValues) => void
  onSetGridSnap: (snap: GridSnapPx) => void
  onPickSector: (name: string) => void
  /** Feeds the game menu's disabled states and its "Unsaved changes" line on present. */
  documentState: () => { isUninitialized: boolean; isDirty: boolean; sectorName: string }
  sectorSettingsValues: () => SectorFormValues
  currentGridSnap: () => GridSnapPx
}

const GRID_SNAP_LABELS: Record<GridSnapPx, string> = {
  32: 'Tiled (32x32)',
  16: 'Tiled (16x16)',
  8: 'Tiled (8x8)',
  4: 'Tiled (4x4)',
  0: 'Free',
}

export class EditorOverlays {
  readonly root: HTMLElement

  private readonly callbacks: EditorOverlayCallbacks
  private readonly views: Record<EditorOverlayKind, HTMLElement>
  private readonly newMapForm: SectorForm
  private readonly settingsForm: SectorForm
  private readonly saveAsInput: HTMLInputElement
  private readonly gridSnapPicker: HTMLSelectElement
  private readonly pickerList: HTMLElement
  private readonly menuSaveButton: HTMLButtonElement
  private readonly menuSaveAsButton: HTMLButtonElement
  private readonly menuSettingsButton: HTMLButtonElement
  private readonly menuDirtyLine: HTMLElement
  private readonly errorBanner: HTMLElement
  private errorTimer: ReturnType<typeof setTimeout> | undefined
  private presentedKind: EditorOverlayKind | undefined

  constructor(callbacks: EditorOverlayCallbacks, floorMaterialIDs: readonly string[]) {
    this.callbacks = callbacks

    // MARK: Game menu — with the browser's own file affordances.
    this.menuSaveButton = button('Save', () => callbacks.onSave())
    this.menuSaveAsButton = button('Save As...', () => callbacks.onShowOverlay('saveAs'))
    this.menuSettingsButton = button('Sector Settings', () => callbacks.onShowOverlay('sectorSettings'))
    this.menuDirtyLine = element('p', { className: 'editor-caption hidden', text: 'Unsaved changes' })
    const gameMenu = element('div', {
      className: 'menu-actions',
      children: [
        button('Resume', () => callbacks.onResume()),
        button('New Map...', () => callbacks.onShowOverlay('newMap')),
        button('Open...', () => callbacks.onShowOverlay('sectorPicker')),
        this.menuSaveButton,
        this.menuSaveAsButton,
        this.menuSettingsButton,
        button('Preferences...', () => callbacks.onShowOverlay('preferences')),
        button('About Somnio Editor', () => callbacks.onShowOverlay('about')),
        this.menuDirtyLine,
      ],
    })

    // MARK: New map / sector settings — the shared sector form, two commit semantics.
    this.newMapForm = new SectorForm(floorMaterialIDs, () => this.newMapForm.renderValidation())
    const newMapOK = button('OK', () => {
      if (!this.newMapForm.renderValidation()) return
      callbacks.onCommitNewMap(this.newMapForm.values())
    })
    const newMap = element('div', {
      children: [
        this.newMapForm.root,
        element('div', {
          className: 'form-actions',
          children: [button('Cancel', () => callbacks.onCancelNewMap()), newMapOK],
        }),
      ],
    })

    this.settingsForm = new SectorForm(floorMaterialIDs, () => this.settingsForm.renderValidation())
    const settingsApply = button('Apply', () => {
      if (!this.settingsForm.renderValidation()) return
      callbacks.onApplySectorSettings(this.settingsForm.values())
    })
    const sectorSettings = element('div', {
      children: [
        this.settingsForm.root,
        element('div', {
          className: 'form-actions',
          children: [button('Cancel', () => callbacks.onShowOverlay('gameMenu')), settingsApply],
        }),
      ],
    })

    // MARK: Preferences — the one picker the Swift Settings scene carried.
    const gridSnap = select(
      'Grid snap',
      GRID_SNAP_PRESETS_PX.map((preset) => ({ value: String(preset), label: GRID_SNAP_LABELS[preset] }))
    )
    this.gridSnapPicker = gridSnap.input
    this.gridSnapPicker.addEventListener('change', () => {
      const parsed = Number(this.gridSnapPicker.value)
      const preset = GRID_SNAP_PRESETS_PX.find((candidate) => candidate === parsed)
      if (preset !== undefined) callbacks.onSetGridSnap(preset)
    })
    const preferences = element('div', {
      children: [
        gridSnap.row,
        element('div', {
          className: 'form-actions',
          children: [button('OK', () => callbacks.onShowOverlay('gameMenu'))],
        }),
      ],
    })

    // MARK: About
    const about = element('div', {
      className: 'about-panel',
      children: [
        element('h1', { className: 'overlay-title overlay-title--large', text: 'Somnio Editor' }),
        element('p', {
          className: 'about-caption',
          text: 'Localhost map editor for .somnio-sector files. Served by vite dev only; never part of the shipped client.',
        }),
        element('div', {
          className: 'form-actions',
          children: [button('OK', () => callbacks.onShowOverlay('gameMenu'))],
        }),
      ],
    })

    // MARK: Sector picker
    this.pickerList = element('div', { className: 'menu-actions editor-sector-list' })
    const sectorPicker = element('div', {
      children: [
        this.pickerList,
        element('div', {
          className: 'form-actions',
          children: [button('New Map...', () => callbacks.onShowOverlay('newMap'))],
        }),
      ],
    })

    // MARK: Save As
    const saveAsRow = field('Sector name')
    const saveAsField = saveAsRow.input
    this.saveAsInput = saveAsField
    const saveAsError = element('p', { className: 'form-error hidden' })
    const saveAsCommit = (): void => {
      const name = this.saveAsInput.value
      if (name === '') {
        saveAsError.textContent = 'Fill in sector name!'
        setHidden(saveAsError, false)
        return
      }
      setHidden(saveAsError, true)
      callbacks.onSaveAs(name)
    }
    saveAsField.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      saveAsCommit()
    })
    const saveAs = element('div', {
      children: [
        saveAsRow.row,
        saveAsError,
        element('div', {
          className: 'form-actions',
          children: [
            button('Cancel', () => callbacks.onShowOverlay('gameMenu')),
            button('Save', saveAsCommit),
          ],
        }),
      ],
    })

    this.views = {
      gameMenu: scrim(card('Somnio Editor', [gameMenu], 'menu')),
      newMap: scrim(card('Create new map', [newMap])),
      sectorSettings: scrim(card('Sector Settings', [sectorSettings])),
      about: scrim(card('About Somnio Editor', [about], 'default', 'accessibleOnly')),
      preferences: scrim(card('Preferences', [preferences], 'menu')),
      sectorPicker: scrim(card('Open Sector', [sectorPicker], 'menu')),
      saveAs: scrim(card('Save As', [saveAs])),
    }
    // A live-region toast rather than a native `alert()`: canvas-context failures (a refused
    // patch overlap, a failed save) must show in a real element so the editor's DOM UI stays
    // inspectable by `agent-browser` and screen readers, per the reason the editor uses DOM at all.
    this.errorBanner = element('div', {
      className: 'editor-error-banner hidden',
      attributes: { role: 'alert', 'aria-live': 'assertive' },
    })
    this.root = element('div', { children: [...Object.values(this.views), this.errorBanner] })
  }

  present(overlay: EditorOverlayKind | undefined): void {
    for (const [kind, view] of Object.entries(this.views)) {
      setHidden(view, overlay !== kind)
    }
    const entered = overlay !== this.presentedKind
    this.presentedKind = overlay
    if (!entered || overlay === undefined) return
    switch (overlay) {
      case 'gameMenu': {
        const state = this.callbacks.documentState()
        this.menuSaveButton.disabled = state.isUninitialized
        this.menuSaveAsButton.disabled = state.isUninitialized
        this.menuSettingsButton.disabled = state.isUninitialized
        setHidden(this.menuDirtyLine, !state.isDirty)
        break
      }
      case 'newMap':
        this.newMapForm.renderValidation()
        this.newMapForm.focusName()
        break
      case 'sectorSettings':
        this.settingsForm.setValues(this.callbacks.sectorSettingsValues())
        this.settingsForm.renderValidation()
        break
      case 'preferences':
        this.gridSnapPicker.value = String(this.callbacks.currentGridSnap())
        break
      case 'saveAs':
        this.saveAsInput.value = this.callbacks.documentState().sectorName
        this.saveAsInput.focus()
        break
      case 'about':
      case 'sectorPicker':
        break
    }
  }

  /** The picker's rows, refreshed by the shell from the file API on present. */
  setSectorList(names: readonly string[]): void {
    replaceChildren(
      this.pickerList,
      names.length === 0
        ? [element('p', { className: 'editor-caption', text: 'No sectors in the sectors directory yet.' })]
        : names.map((name) => button(name, () => this.callbacks.onPickSector(name)))
    )
  }

  /** Surfaces a failed save/load without leaving the current overlay state. */
  showError(message: string): void {
    console.error(message)
    this.errorBanner.textContent = message
    setHidden(this.errorBanner, false)
    if (this.errorTimer !== undefined) clearTimeout(this.errorTimer)
    this.errorTimer = setTimeout(() => setHidden(this.errorBanner, true), 4000)
  }
}
