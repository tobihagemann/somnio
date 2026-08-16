import * as THREE from 'three'
import registryJSON from '@registry'
import { bundledModelRegistry } from '@/core/modelRegistry'
import type { GridPoint } from '@/core/geometry'
import type { Sector } from '@/core/sector'
import { objectAnchorBottomY, objectNodePosition } from '@/scene/placement'
import { wheelDeltaToNativeScale } from '@/scene/cameraRig'
import { HttpModelAssets } from '@/scene/modelAssets'
import { WorldScene } from '@/scene/worldScene'
import { element, floating } from '@/ui/dom'
import { AuthoringOverlay } from './authoringOverlay'
import type { AuthoringFacingHandle, AuthoringHandleSet } from './authoringOverlay'
import { gridPoint, nudgeDelta } from './canvasController'
import type { EditorTool } from './canvasController'
import { captureClipboard, emptyClipboard, isClipboardEmpty, validatedPaste } from './clipboard'
import type { EditorClipboard } from './clipboard'
import { handleEditorKeydown } from './commands'
import type { EditorCommandTarget } from './commands'
import { EditorDocument, listSectors } from './document'
import * as drag from './dragController'
import type { DragSession } from './dragController'
import { EditorCamera, scrollIntent } from './framing'
import { currentGridSnapPx, persistGridSnapPx } from './preferences'
import { isValidSectorName } from './sectorName'
import { isValidSelection, removeAllSelections, selectionBounds, selectionsEqual } from './selection'
import type { EditorSelection } from './selection'
import { CursorReadout } from './ui/cursorReadout'
import { InspectorPanel } from './ui/inspector'
import { EditorOverlays } from './ui/overlays'
import type { EditorOverlayKind } from './ui/overlays'
import type { SectorFormValues } from './ui/sectorForm'
import { ToolPalette } from './ui/toolPalette'

/**
 * The editor's composition root, mirroring `AppShell`'s shape (canvas, renderer, RAF loop,
 * host handlers, a `startRendering` option for headless tests) — but constructing only the
 * model assets, the world scene, the authoring overlay, and the editor UI. `AppShell` itself
 * is unusable here: its constructor unconditionally builds the connection, transport,
 * session, and gameplay panels.
 *
 * Also the workspace state: tool, selection, hover anchor, presented overlay, drag
 * state, and the reconcile/refresh split — a document mutation reloads the whole scene and
 * re-applies the editor framing (`WorldScene.load` unconditionally snaps the camera to the
 * sector centre, so the re-apply is what preserves the user's pan/zoom), while live drags
 * update only the gizmos plus, for a move, the mapped meshes.
 */

export interface EditorShellOptions {
  container: HTMLElement
  /** Skips the `WebGLRenderer` and frame loop so the shell can be driven headlessly. */
  startRendering?: boolean
}

export class EditorShell implements EditorCommandTarget {
  readonly document = new EditorDocument()
  readonly scene: WorldScene
  readonly authoringOverlay = new AuthoringOverlay()
  readonly camera: EditorCamera
  readonly overlays: EditorOverlays
  readonly inspector: InspectorPanel
  readonly palette: ToolPalette
  readonly readout: CursorReadout

  tool: EditorTool = 'select'
  selection: EditorSelection[] = []
  presentedOverlay: EditorOverlayKind | undefined
  showGridOverlay = false
  /**
   * Last grid point the cursor hovered — the paste anchor. Unlike the readout (which resets
   * for display when the hover ends), this survives the pointer leaving the canvas so ⌘V
   * after mousing to a panel still lands where the user last pointed.
   */
  lastHoveredGrid: GridPoint | undefined

  private readonly container: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly marqueeNode: HTMLElement
  private readonly objectModelIDs: readonly string[]
  private readonly floorMaterialIDs: readonly string[]
  private renderer: THREE.WebGLRenderer | undefined
  private lastFrameMs: number | undefined

  private clipboard: EditorClipboard = emptyClipboard()
  private dragSession: DragSession | undefined
  private dragStart: { x: number; y: number } | undefined
  private dragAdditive = false
  private dragPreview: Sector | undefined
  /** Authored node positions of live-moved meshes, restored when a drag commits nothing. */
  private liveMovedNodes: {
    index: number
    node: THREE.Object3D
    position: THREE.Vector3
    depth: number
  }[] = []

  constructor(options: EditorShellOptions) {
    this.container = options.container
    const registry = bundledModelRegistry(registryJSON)
    this.objectModelIDs = registry.objectModels.map((entry) => entry.id)
    this.floorMaterialIDs = registry.floorMaterials.map((entry) => entry.id)

    this.canvas = element('canvas', { attributes: { id: 'somnio-editor-canvas' } })
    this.marqueeNode = element('div', { className: 'editor-marquee hidden' })
    this.scene = new WorldScene(new HttpModelAssets(registry), this.aspect())
    this.scene.scene.add(this.authoringOverlay.root)
    this.camera = new EditorCamera(this.scene.camera)

    this.palette = new ToolPalette((tool) => {
      this.tool = tool
      this.palette.render(tool)
    })
    this.inspector = new InspectorPanel(
      {
        mutate: (actionName, change) => this.mutateGuarded(actionName, change),
        onDeleteSelection: () => this.deleteSelection(),
        onOpenSectorSettings: () => this.present('sectorSettings'),
      },
      { objectModelIDs: this.objectModelIDs, floorMaterialIDs: this.floorMaterialIDs }
    )
    this.readout = new CursorReadout()
    this.overlays = new EditorOverlays(this.overlayCallbacks(), this.floorMaterialIDs)

    this.container.append(
      this.canvas,
      this.marqueeNode,
      floating('top-leading', [this.palette.root]),
      floating('top-trailing', [this.inspector.root]),
      floating('bottom-leading', [this.readout.root]),
      this.overlays.root
    )

    this.document.onChanged = () => this.reconcile()
    this.installHostHandlers()
    if (options.startRendering ?? true) this.startRenderer()
    this.renderUI()
    this.present('sectorPicker')
  }

  // MARK: - Overlay routing

  private overlayCallbacks(): ConstructorParameters<typeof EditorOverlays>[0] {
    return {
      onResume: () => this.present(undefined),
      onShowOverlay: (kind) => this.present(kind),
      onSave: () => {
        this.present(undefined)
        this.save()
      },
      onSaveAs: (name) => {
        if (!isValidSectorName(name)) {
          this.overlays.showError('Invalid sector name!')
          return
        }
        void this.document
          .saveAs(name)
          .then(() => this.present(undefined))
          .catch((error: unknown) => this.overlays.showError(String(error)))
      },
      onCommitNewMap: (values) => {
        if (!this.confirmDiscardIfDirty()) return
        this.document.create(values)
        this.selection = []
        this.present(undefined)
      },
      onCancelNewMap: () => {
        this.present(this.document.isUninitialized ? 'sectorPicker' : 'gameMenu')
      },
      onApplySectorSettings: (values) => this.applySectorSettings(values),
      onSetGridSnap: (snap) => {
        persistGridSnapPx(snap)
        this.refreshOverlay()
      },
      onPickSector: (name) => {
        if (!this.confirmDiscardIfDirty()) return
        void this.document
          .load(name)
          .then(() => {
            this.selection = []
            this.present(undefined)
          })
          .catch((error: unknown) => this.overlays.showError(String(error)))
      },
      documentState: () => ({
        isUninitialized: this.document.isUninitialized,
        isDirty: this.document.isDirty,
        sectorName: this.document.sector.name,
      }),
      sectorSettingsValues: (): SectorFormValues => ({
        name: this.document.sector.name,
        width: this.document.sector.dimensions.width,
        height: this.document.sector.dimensions.height,
        indoor: this.document.sector.light.indoor,
        brightness: this.document.sector.light.brightness,
        floorMaterialID: this.document.sector.floorMaterialID,
      }),
      currentGridSnap: () => currentGridSnapPx(),
    }
  }

  present(overlay: EditorOverlayKind | undefined): void {
    this.presentedOverlay = overlay
    this.overlays.present(overlay)
    if (overlay === 'sectorPicker') {
      void listSectors()
        .then((names) => this.overlays.setSectorList(names))
        .catch((error: unknown) => this.overlays.showError(String(error)))
    }
  }

  /**
   * The Esc state machine: overlays back out one
   * level toward the game menu, a live selection clears, live editing opens the menu. The
   * picker/new-map over an uninitialized document is the floor — nothing is behind it, so
   * Esc there is a consumed no-op.
   */
  handleEscape(): void {
    switch (this.presentedOverlay) {
      case 'newMap':
      case 'sectorPicker':
        if (!this.document.isUninitialized) this.present('gameMenu')
        break
      case 'sectorSettings':
      case 'about':
      case 'preferences':
      case 'saveAs':
        this.present('gameMenu')
        break
      case 'gameMenu':
        this.present(undefined)
        break
      case undefined:
        if (this.selection.length > 0) {
          this.selection = []
          this.selectionChanged()
        } else {
          this.present('gameMenu')
        }
        break
    }
  }

  // MARK: - Commands

  isOverlayPresented(): boolean {
    return this.presentedOverlay !== undefined
  }

  save(): void {
    if (this.document.isUninitialized) return
    void this.document.save().catch((error: unknown) => this.overlays.showError(String(error)))
  }

  presentSaveAs(): void {
    if (this.document.isUninitialized) return
    this.present('saveAs')
  }

  undo(): void {
    this.document.undo()
  }

  redo(): void {
    this.document.redo()
  }

  /** `⌘D`: copy + paste-offset in one undo step, no clipboard round-trip. */
  duplicateSelection(): void {
    const clipboard = captureClipboard(this.selection, this.document.sector)
    if (isClipboardEmpty(clipboard)) return
    const pasted = validatedPaste(
      clipboard,
      this.document.sector,
      undefined,
      Math.max(1, currentGridSnapPx())
    )
    if (pasted === undefined) return
    if (this.wouldIntroducePatchOverlap(pasted.sector)) {
      this.overlays.showError('Floor patches must not overlap.')
      return
    }
    this.document.mutate('Duplicate Selection', (sector) => {
      Object.assign(sector, pasted.sector)
    })
    this.selection = pasted.selection
    this.selectionChanged()
  }

  toggleGrid(): void {
    this.showGridOverlay = !this.showGridOverlay
    this.refreshOverlay()
  }

  copySelection(): void {
    const captured = captureClipboard(this.selection, this.document.sector)
    if (!isClipboardEmpty(captured)) this.clipboard = captured
  }

  /**
   * `⌘V`: appends the clones anchored at the last hovered grid point (surviving the pointer
   * leaving the canvas), falling back to a one-grid-step offset, and selects them. The paste
   * gate accepts only a body the writer round-trips.
   */
  paste(): void {
    const pasted = validatedPaste(
      this.clipboard,
      this.document.sector,
      this.lastHoveredGrid,
      Math.max(1, currentGridSnapPx())
    )
    if (pasted === undefined) return
    if (this.wouldIntroducePatchOverlap(pasted.sector)) {
      this.overlays.showError('Floor patches must not overlap.')
      return
    }
    this.document.mutate('Paste', (sector) => {
      Object.assign(sector, pasted.sector)
    })
    this.selection = pasted.selection
    this.selectionChanged()
  }

  /** `⌘A` Select All. */
  selectAll(): void {
    const sector = this.document.sector
    const all: EditorSelection[] = [
      ...sector.npcs.map((_, index): EditorSelection => ({ kind: 'npc', index })),
      ...sector.monsterSpawns.map((_, index): EditorSelection => ({ kind: 'monsterSpawn', index })),
      ...sector.portals.map((_, index): EditorSelection => ({ kind: 'portal', index })),
      ...sector.collisionMasks.map((_, index): EditorSelection => ({ kind: 'mask', index })),
      ...sector.objects.map((_, index): EditorSelection => ({ kind: 'object', index })),
      ...sector.floorPatches.map((_, index): EditorSelection => ({ kind: 'floorPatch', index })),
    ]
    this.selection = all
    this.selectionChanged()
  }

  deleteSelection(): void {
    if (this.presentedOverlay !== undefined || this.selection.length === 0) return
    const selections = this.selection
    this.document.mutate('Delete selection', (sector) => {
      removeAllSelections(selections, sector)
    })
    this.selection = []
    this.selectionChanged()
  }

  /** Arrow-key nudge: 1 px, or one grid step with Shift, as one undo step per press. */
  nudgeSelection(key: string, shiftHeld: boolean): boolean {
    if (this.selection.length === 0) return false
    const delta = nudgeDelta(key, shiftHeld, currentGridSnapPx())
    if (delta === undefined) return false
    const originals = drag.origins(this.selection, this.document.sector)
    this.mutateGuarded('Move selection', (sector) => {
      drag.applyMove(originals, delta.dx, delta.dy, sector)
    })
    return true
  }

  // MARK: - Mutation plumbing

  /**
   * The floor-patch overlap gate, applied at commit only — never at save and never at load.
   * Authored patches may not overlap (coplanar quads z-fight), but a legacy file that already
   * carries an overlap still opens, edits elsewhere, and saves; only a commit that
   * *introduces* an overlap is refused, with one validation message.
   */
  private mutateGuarded(actionName: string, change: (sector: Sector) => void): void {
    const candidate = structuredClone(this.document.sector)
    change(candidate)
    if (this.wouldIntroducePatchOverlap(candidate)) {
      this.overlays.showError('Floor patches must not overlap.')
      return
    }
    this.document.mutate(actionName, change)
  }

  private wouldIntroducePatchOverlap(candidate: Sector): boolean {
    // Refuse a commit that introduces a *new* overlapping pair, so a file already carrying an
    // overlap still edits elsewhere. A subset check, not a count: an edit that trades one overlap
    // for a different one keeps the count constant but is still a new overlap and must be refused.
    const before = overlappingPatchPairs(this.document.sector)
    for (const pair of overlappingPatchPairs(candidate)) {
      if (!before.has(pair)) return true
    }
    return false
  }

  private applySectorSettings(values: SectorFormValues): void {
    const sector = this.document.sector
    // Two undo steps, as natively: the rename and the field edit are distinct actions.
    if (values.name !== sector.name) {
      this.document.mutate('Rename sector', (draft) => {
        draft.name = values.name
      })
    }
    const changed =
      values.width !== sector.dimensions.width ||
      values.height !== sector.dimensions.height ||
      values.indoor !== sector.light.indoor ||
      values.brightness !== sector.light.brightness ||
      values.floorMaterialID !== sector.floorMaterialID
    if (changed) {
      this.document.mutate('Edit sector settings', (draft) => {
        draft.dimensions = { width: values.width, height: values.height }
        draft.light = { indoor: values.indoor, brightness: values.brightness }
        draft.floorMaterialID = values.floorMaterialID
      })
    }
    this.present(undefined)
  }

  private confirmDiscardIfDirty(): boolean {
    if (!this.document.isDirty) return true
    return globalThis.confirm?.('Discard unsaved changes?') ?? true
  }

  // MARK: - Reconcile / refresh

  /**
   * Full reload after a document mutation: swap the rendered sector graph, re-apply the
   * editor framing (`load` snaps the camera to the sector centre otherwise), clamp the
   * selection, refresh the gizmos. A reconcile during a live drag means an external mutation
   * invalidated the session's snapshotted indices — the session is dropped so a resumed
   * gesture can never mutate re-indexed records.
   */
  private reconcile(): void {
    this.resetDragState()
    if (!this.document.isUninitialized) {
      this.scene.load(this.document.sector, false)
      this.camera.refreshFraming(this.document.sector)
    }
    this.selection = this.selection.filter((selection) => isValidSelection(selection, this.document.sector))
    this.readout.applyBounds(this.selection, this.document.sector)
    this.refreshOverlay()
    this.renderUI()
  }

  /**
   * Overlay-only refresh — no sector-graph rebuild. While a drag is live the preview body
   * wins, so move/resize/rotate render without a mutation. Also re-run on every camera
   * change: the handle extents are screen-constant points, so their world geometry depends
   * on the live pixels-per-point factor.
   */
  private refreshOverlay(): void {
    if (this.document.isUninitialized) return
    const shown = this.dragPreview ?? this.document.sector
    const pxPerPt = this.camera.legacyPixelsPerViewportPoint()
    let resizeHandles: AuthoringHandleSet | undefined
    let facingHandle: AuthoringFacingHandle | undefined
    if (this.selection.length === 1) {
      const selected = this.selection[0]!
      const bounds = selectionBounds(selected, shown)
      if (bounds !== undefined) {
        resizeHandles = {
          centerPixels: drag.handleCenters(bounds.origin, bounds.size).map((entry) => entry.pixel),
          extentPx: drag.HANDLE_DRAW_EXTENT_PT * pxPerPt,
        }
      }
      if (selected.kind === 'npc') {
        const npc = shown.npcs[selected.index]
        if (npc !== undefined) {
          facingHandle = {
            centerPixel: drag.spawnBoxCenter(npc.spawnOrigin, npc.spawnBoxSize),
            handlePixel: drag.facingHandlePixel(
              npc.spawnOrigin,
              npc.spawnBoxSize,
              npc.facing,
              drag.FACING_CLEARANCE_PT * pxPerPt
            ),
            extentPx: drag.HANDLE_DRAW_EXTENT_PT * pxPerPt,
          }
        }
      }
    }
    this.authoringOverlay.update({
      sector: shown,
      selectionBounds: this.selection
        .map((selection) => selectionBounds(selection, shown))
        .filter((bounds) => bounds !== undefined),
      resizeHandles,
      facingHandle,
      showGrid: this.showGridOverlay,
      gridStepPx: currentGridSnapPx(),
    })
  }

  private selectionChanged(): void {
    this.readout.applyBounds(this.selection, this.document.sector)
    this.refreshOverlay()
    this.renderUI()
  }

  private renderUI(): void {
    this.palette.render(this.tool)
    this.inspector.render(this.document.sector, this.selection, this.document.isUninitialized)
    this.readout.render(this.document.sector.name)
  }

  // MARK: - Host handlers

  private installHostHandlers(): void {
    window.addEventListener('resize', () => this.handleResize())
    window.addEventListener('keydown', (event) => handleEditorKeydown(this, event))
    // Explicit `⌘S` saves are the only write path, so a mis-closed tab must prompt.
    window.addEventListener('beforeunload', (event) => {
      if (!this.document.isDirty) return
      event.preventDefault()
      // Legacy support (Chrome/Edge < 119, older WebKit): those engines gate the dialog on a
      // truthy `returnValue` rather than `preventDefault()`.
      event.returnValue = true
    })

    this.canvas.addEventListener('pointerdown', (event) => this.handlePointerDown(event))
    this.canvas.addEventListener('pointermove', (event) => this.handlePointerMove(event))
    this.canvas.addEventListener('pointerup', (event) => this.handlePointerUp(event))
    // A cancelled pointer (palm rejection, app switch, capture loss) fires no `pointerup`, so
    // without this the drag session survives the gesture and the next move resumes it.
    this.canvas.addEventListener('pointercancel', () => this.cancelDragState())
    this.canvas.addEventListener('lostpointercapture', () => this.cancelDragState())
    this.canvas.addEventListener('pointerleave', () => {
      this.readout.x = 0
      this.readout.y = 0
      this.readout.render(this.document.sector.name)
    })
    this.canvas.addEventListener(
      'wheel',
      (event) => {
        if (this.presentedOverlay !== undefined) return
        event.preventDefault()
        this.handleWheel(event)
      },
      { passive: false }
    )
  }

  /**
   * Scroll navigation, through the ported `scrollIntent`: DOM wheel deltas are sign-opposite
   * AppKit scrolling deltas, so both axes negate at this boundary — the same conversion the
   * player session applies to its zoom.
   */
  private handleWheel(event: WheelEvent): void {
    if (this.document.isUninitialized) return
    const intent = scrollIntent({
      deltaX: -event.deltaX,
      deltaY: -event.deltaY,
      hasPreciseDeltas: event.deltaMode === 0,
      commandHeld: event.metaKey || event.ctrlKey,
      shiftHeld: event.shiftKey,
    })
    if (intent.kind === 'zoom') {
      this.camera.zoom(wheelDeltaToNativeScale(intent.deltaY, event.deltaMode), this.document.sector)
    } else {
      this.camera.pan(intent.delta, this.document.sector)
    }
    this.refreshOverlay()
  }

  private dragContext(): drag.DragContext {
    return {
      camera: this.scene.camera,
      viewport: this.camera.viewportSize,
      gridStep: currentGridSnapPx(),
    }
  }

  private placementDefaults(): drag.PlacementDefaults {
    return {
      objectModelID: this.objectModelIDs[0] ?? '',
      floorMaterialID: this.floorMaterialIDs[0] ?? '',
    }
  }

  private handlePointerDown(event: PointerEvent): void {
    if (event.button !== 0 || this.presentedOverlay !== undefined || this.document.isUninitialized) {
      return
    }
    // Guarded: capture keeps a drag alive when the pointer leaves the canvas, but a
    // synthetic `PointerEvent` (test drivers) has no active pointer to capture and throws.
    try {
      this.canvas.setPointerCapture(event.pointerId)
    } catch {
      // The drag still works; it just loses the off-canvas grace.
    }
    this.resetDragState()
    const location = this.canvasPoint(event)
    this.dragAdditive = event.shiftKey
    const begun = drag.beginSession(
      location,
      this.tool,
      this.dragAdditive,
      this.document.sector,
      this.selection,
      this.dragContext()
    )
    this.dragSession = begun.session
    this.dragStart = location
    if (!selectionsEqual(begun.selection, this.selection)) {
      this.selection = begun.selection
      this.selectionChanged()
    }
  }

  private handlePointerMove(event: PointerEvent): void {
    const location = this.canvasPoint(event)
    if (this.presentedOverlay === undefined && !this.document.isUninitialized) {
      const grid = gridPoint(this.scene.camera, this.camera.viewportSize, location)
      this.readout.x = grid.x
      this.readout.y = grid.y
      this.lastHoveredGrid = grid
      this.readout.render(this.document.sector.name)
    }
    const session = this.dragSession
    const start = this.dragStart
    if (session === undefined || start === undefined) return
    if (session.kind === 'marquee') {
      this.renderMarquee(start, location)
      return
    }
    this.dragPreview = drag.preview(
      session,
      start,
      location,
      this.document.sector,
      this.dragContext(),
      this.placementDefaults()
    )
    if (session.kind === 'move' && this.dragPreview !== undefined) {
      this.applyLiveMove(session, this.dragPreview)
    }
    this.refreshOverlay()
  }

  private handlePointerUp(event: PointerEvent): void {
    const session = this.dragSession
    const start = this.dragStart
    const additive = this.dragAdditive
    const restore = this.liveMovedNodes
    this.resetDragState()
    if (session === undefined || start === undefined) {
      this.refreshOverlay()
      return
    }
    const before = this.document.undoDepth
    const committed = drag.endSession(
      session,
      start,
      this.canvasPoint(event),
      additive,
      { mutate: (actionName, change) => this.mutateGuarded(actionName, change) },
      this.document.sector,
      this.selection,
      this.dragContext(),
      this.placementDefaults()
    )
    // Filtered against the live document: a placement the patch-overlap gate refused has
    // probed its selection into the commit closure without the record ever landing.
    const nextSelection = committed.filter((selection) => isValidSelection(selection, this.document.sector))
    // A commit reconciles the scene wholesale; a no-op commit (zero-delta move, refused
    // patch overlap) must put any live-moved meshes back where the document says they are.
    if (this.document.undoDepth === before) {
      for (const { node, position } of restore) node.position.copy(position)
    }
    if (!selectionsEqual(nextSelection, this.selection)) {
      this.selection = nextSelection
      this.selectionChanged()
    } else {
      this.refreshOverlay()
    }
  }

  /**
   * The live-mesh half of a move drag: translate each selected object's real node with the
   * placement math the renderer uses. Objects only — floor patches bake sector-space UVs
   * into their geometry, so their gizmo rect previews while the mesh rebuilds on commit.
   */
  private applyLiveMove(session: Extract<DragSession, { kind: 'move' }>, previewSector: Sector): void {
    // Snapshot the node identity, its rest position, and its mesh depth once: none of the three
    // changes for the duration of the drag, so resolving the node and rebuilding its bounding box
    // on every pointer move would scan and re-measure every selected object each frame.
    if (this.liveMovedNodes.length === 0) {
      for (const { selection } of session.originals) {
        if (selection.kind !== 'object') continue
        const node = this.scene.objectNodeForIndex(selection.index)
        if (node !== undefined) {
          const depth = new THREE.Box3().setFromObject(node).getSize(new THREE.Vector3()).z
          this.liveMovedNodes.push({ index: selection.index, node, position: node.position.clone(), depth })
        }
      }
    }
    for (const { index, node, depth } of this.liveMovedNodes) {
      const object = previewSector.objects[index]
      if (object === undefined) continue
      const anchor = objectAnchorBottomY(object, previewSector.collisionMasks)
      const position = objectNodePosition(object, anchor, depth)
      node.position.set(position.x, position.y, position.z)
    }
  }

  private renderMarquee(start: { x: number; y: number }, current: { x: number; y: number }): void {
    const left = Math.min(start.x, current.x)
    const top = Math.min(start.y, current.y)
    this.marqueeNode.classList.remove('hidden')
    this.marqueeNode.style.left = `${left}px`
    this.marqueeNode.style.top = `${top}px`
    this.marqueeNode.style.width = `${Math.abs(current.x - start.x)}px`
    this.marqueeNode.style.height = `${Math.abs(current.y - start.y)}px`
  }

  private resetDragState(): void {
    this.dragSession = undefined
    this.dragStart = undefined
    this.dragAdditive = false
    this.dragPreview = undefined
    this.liveMovedNodes = []
    this.marqueeNode.classList.add('hidden')
  }

  /**
   * Abandons an in-flight drag without committing it — for `pointercancel`/`lostpointercapture`,
   * which fire in place of `pointerup`. Any live-moved meshes go back to their rest positions
   * first, then the session clears. Inert when no drag is active (a normal pointerup already
   * reset, and `lostpointercapture` also fires at the clean end of every drag).
   */
  private cancelDragState(): void {
    if (this.dragSession === undefined) return
    for (const { node, position } of this.liveMovedNodes) node.position.copy(position)
    this.resetDragState()
  }

  private canvasPoint(event: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  // MARK: - Rendering

  private aspect(): number {
    const width = this.container.clientWidth || window.innerWidth || 1
    const height = this.container.clientHeight || window.innerHeight || 1
    return width / height
  }

  private startRenderer(): void {
    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer = renderer
    this.handleResize()
    void this.scene.prewarm().then(() => this.reconcile())
    const step = (timestamp: number): void => {
      const delta = this.lastFrameMs === undefined ? 0 : (timestamp - this.lastFrameMs) / 1000
      this.lastFrameMs = timestamp
      this.scene.tick(Math.min(delta, 0.1))
      renderer.render(this.scene.scene, this.scene.camera)
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }

  private handleResize(): void {
    const width = this.container.clientWidth || window.innerWidth
    const height = this.container.clientHeight || window.innerHeight
    this.renderer?.setSize(width, height, false)
    this.camera.updateViewportSize({ width, height }, this.document.sector)
    this.refreshOverlay()
  }

  // MARK: - Debug surface

  recordCounts(): Record<string, number> {
    const sector = this.document.sector
    return {
      objects: sector.objects.length,
      collisionMasks: sector.collisionMasks.length,
      portals: sector.portals.length,
      npcs: sector.npcs.length,
      monsterSpawns: sector.monsterSpawns.length,
      floorPatches: sector.floorPatches.length,
    }
  }
}

/**
 * The set of overlapping floor-patch index pairs (`"a,b"`, a < b). Exclusive edges, matching
 * `CollisionMaskOverlap`'s polarity: flush rects do not overlap. The commit gate compares this
 * set before and after an edit so it refuses a *newly introduced* pair while tolerating one a
 * legacy file already carried. Index-based keys are stable across the edits that can introduce an
 * overlap — move/resize/nudge keep indices, paste/duplicate append them; delete only removes
 * pairs — so a pair present after but absent before is genuinely new.
 */
function overlappingPatchPairs(sector: Sector): Set<string> {
  const patches = sector.floorPatches
  const pairs = new Set<string>()
  for (let a = 0; a < patches.length; a += 1) {
    for (let b = a + 1; b < patches.length; b += 1) {
      const first = patches[a]!
      const second = patches[b]!
      if (
        first.x < second.x + second.width &&
        first.x + first.width > second.x &&
        first.y < second.y + second.height &&
        first.y + first.height > second.y
      ) {
        pairs.add(`${a},${b}`)
      }
    }
  }
  return pairs
}
