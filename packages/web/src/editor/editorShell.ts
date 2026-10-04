import * as THREE from 'three';
import { MONSTER_KIND_IDS, bundledModelRegistry, sectorOrigin } from '@somnio/core';
import type { ModelRegistry, Point, Sector } from '@somnio/core';
import { wheelDeltaToZoomDelta } from '@/scene/cameraRig';
import { HttpModelAssets } from '@/scene/modelAssets';
import { WorldScene } from '@/scene/worldScene';
import { element, floating } from '@/ui/dom';
import { AuthoringOverlay, overlayLabels } from './authoringOverlay';
import type { AuthoringFacingHandle, AuthoringHandleSet } from './authoringOverlay';
import { candidateSelections, gridPoint, nudgeDelta, screenPoint } from './canvasController';
import type { EditorTool } from './canvasController';
import { captureClipboard, emptyClipboard, insertClipboard, isClipboardEmpty } from './clipboard';
import type { EditorClipboard } from './clipboard';
import { handleEditorKeydown } from './commands';
import type { EditorCommandTarget } from './commands';
import { EditorDocument, applySectorSettings, listSectors, loadSector, sectorSettings } from './document';
import type { CommitResult, SectorSettings } from './document';
import { FACING_CLEARANCE_PT, HANDLE_DRAW_EXTENT_PT, facingHandlePoint, handleCenters, metresPerViewportPoint } from './drag/geometry';
import type { DragContext } from './drag/geometry';
import { applyMove, origins, turnable } from './drag/mutations';
import type { PlacementDefaults } from './drag/mutations';
import { beginSession, endSession, preview } from './drag/session';
import type { DragSession } from './drag/session';
import { EditorCamera, scrollIntent } from './framing';
import { currentGridSnap, persistGridSnap, stepOrFine } from './preferences';
import { isValidSectorName } from './sectorName';
import {
  byId,
  followRename,
  isValidSelection,
  nextDoorId,
  rectRecord,
  removeAllSelections,
  renameRecord,
  selectionFootprint,
  selectionsEqual,
} from './selection';
import type { EditorSelection, RecordRename } from './selection';
import { documentIssues, neighbours } from './surroundings';
import type { DocumentIssues } from './surroundings';
import { CursorReadout } from './ui/cursorReadout';
import { InspectorPanel } from './ui/inspector';
import { EditorOverlays } from './ui/overlays';
import type { EditorOverlayKind } from './ui/overlays';
import { RecordLabels } from './ui/recordLabels';
import { ToolPalette } from './ui/toolPalette';

/**
 * The editor's composition root, mirroring `AppShell`'s shape (canvas, renderer, RAF loop,
 * host handlers, a `startRendering` option for headless tests) — but constructing only the
 * model assets, the world scene, the authoring overlay, and the editor UI. `AppShell` itself
 * is unusable here: its constructor unconditionally builds the connection, transport,
 * session, and gameplay panels.
 *
 * Also the workspace state: tool, selection, hover anchor, presented overlay, drag
 * state, and the reconcile/refresh split — a document change redraws the document's sector and
 * recomputes what the world would report about it, while live drags update only the gizmos
 * plus, for a move or a turn, the placement's own node.
 */

export interface EditorShellOptions {
  container: HTMLElement;
  /** Skips the `WebGLRenderer` and frame loop so the shell can be driven headlessly. */
  startRendering?: boolean;
}

export class EditorShell implements EditorCommandTarget {
  readonly document = new EditorDocument();
  readonly scene: WorldScene;
  readonly authoringOverlay = new AuthoringOverlay();
  readonly camera: EditorCamera;
  readonly overlays: EditorOverlays;
  readonly inspector: InspectorPanel;
  readonly palette: ToolPalette;
  readonly readout: CursorReadout;
  readonly labels = new RecordLabels();

  tool: EditorTool = 'select';
  selection: EditorSelection[] = [];
  presentedOverlay: EditorOverlayKind | undefined;
  showGridOverlay = false;
  /**
   * Last ground point the cursor hovered — the paste anchor. Unlike the readout (which resets
   * for display when the hover ends), this survives the pointer leaving the canvas so ⌘V
   * after mousing to a panel still lands where the user last pointed.
   */
  lastHoveredGrid: Point | undefined;
  /** What the world would report about the document, as of the last document change. */
  issues: DocumentIssues = { error: undefined, records: [] };

  private readonly container: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly marqueeNode: HTMLElement;
  private readonly registry: ModelRegistry;
  private renderer: THREE.WebGLRenderer | undefined;
  private lastFrameMs: number | undefined;

  /** Every other sector the file API holds: the neighbours to draw and the sectors a door can lead to. */
  private others: Sector[] = [];
  /** The names the scene currently draws: the document's sector and its read-only neighbours. */
  private drawnDocument: string | undefined;
  private readonly drawnNeighbours = new Set<string>();
  /** The model the placement tool stamps: that of the placement selected last. */
  private placementModelId: string;

  private clipboard: EditorClipboard = emptyClipboard();
  private dragSession: DragSession | undefined;
  private dragStart: { x: number; y: number } | undefined;
  private dragAdditive = false;
  private dragPreview: Sector | undefined;
  /** Where the live-dragged placements' nodes stood, restored when a drag commits nothing. */
  private liveNodes: { id: string; node: THREE.Object3D; position: THREE.Vector3; yaw: number }[] = [];

  constructor(options: EditorShellOptions) {
    this.container = options.container;
    this.registry = bundledModelRegistry();
    this.placementModelId = this.registry.objectModels[0]?.id ?? '';
    const floorMaterialIds = this.registry.floorMaterials.map((entry) => entry.id);

    this.canvas = element('canvas', { attributes: { id: 'somnio-editor-canvas' } });
    this.marqueeNode = element('div', { className: 'editor-marquee hidden' });
    this.scene = new WorldScene(new HttpModelAssets(this.registry), this.registry, this.aspect());
    this.scene.scene.add(this.authoringOverlay.root);
    this.camera = new EditorCamera(this.scene.camera, (focus) => this.scene.anchorSunShadow(focus));

    this.palette = new ToolPalette((tool) => {
      this.tool = tool;
      this.palette.render(tool);
    });
    this.inspector = new InspectorPanel(
      {
        mutate: (actionName, change) => this.mutate(actionName, change),
        rename: (selection, id) => this.renameSelection(selection, id),
        onSelect: (selection) => this.select([selection]),
        onAddDoor: (placementId, anchor) => this.addDoor(placementId, anchor),
        onDeleteSelection: () => this.deleteSelection(),
        onOpenSectorSettings: () => this.present('sectorSettings'),
        otherSectors: () => this.others,
        issues: () => this.issues,
      },
      this.registry,
    );
    this.readout = new CursorReadout();
    this.overlays = new EditorOverlays(this.overlayCallbacks(), floorMaterialIds);

    this.container.append(
      this.canvas,
      this.labels.root,
      this.marqueeNode,
      floating('top-leading', [this.palette.root]),
      floating('top-trailing', [this.inspector.root]),
      floating('bottom-leading', [this.readout.root]),
      this.overlays.root,
    );

    this.document.onChanged = (rename) => {
      // Before the reconcile, which drops a selection whose id the document no longer holds.
      if (rename !== undefined) this.selection = followRename(this.selection, rename);
      this.reconcile();
    };
    this.installHostHandlers();
    if (options.startRendering ?? true) this.startRenderer();
    this.renderUI();
    this.present('sectorPicker');
  }

  private overlayCallbacks(): ConstructorParameters<typeof EditorOverlays>[0] {
    const showError = (error: unknown): void => this.overlays.showError(String(error));
    return {
      onResume: () => this.present(undefined),
      onShowOverlay: (kind) => this.present(kind),
      onSave: () => {
        this.present(undefined);
        this.save();
      },
      onSaveAs: (name) => {
        if (!isValidSectorName(name)) {
          this.overlays.showError('Invalid sector name!');
          return;
        }
        void this.document
          .saveAs(name)
          .then(() => {
            this.present(undefined);
            return this.loadOthers();
          })
          .catch(showError);
      },
      onCommitNewMap: (values) => {
        if (!this.confirmDiscardIfDirty()) return;
        const result = this.document.create(values);
        if (!result.accepted) {
          this.overlays.showError(result.message);
          return;
        }
        this.selection = [];
        this.present(undefined);
        void this.loadOthers().catch(showError);
      },
      onCancelNewMap: () => {
        this.present(this.document.isUninitialized ? 'sectorPicker' : 'gameMenu');
      },
      onApplySectorSettings: (values) => this.applySectorSettings(values),
      onSetGridSnap: (snap) => {
        persistGridSnap(snap);
        this.refreshOverlay();
      },
      onPickSector: (name) => {
        if (!this.confirmDiscardIfDirty()) return;
        void this.document
          .load(name)
          .then(() => {
            this.selection = [];
            this.present(undefined);
            return this.loadOthers();
          })
          .catch(showError);
      },
      documentState: () => ({
        isUninitialized: this.document.isUninitialized,
        isDirty: this.document.isDirty,
        sectorName: this.document.sector.name,
      }),
      sectorSettingsValues: () => sectorSettings(this.document.sector),
      currentGridSnap: () => currentGridSnap(),
    };
  }

  present(overlay: EditorOverlayKind | undefined): void {
    this.presentedOverlay = overlay;
    this.overlays.present(overlay);
    if (overlay === 'sectorPicker') {
      void listSectors()
        .then((names) => this.overlays.setSectorList(names))
        .catch((error: unknown) => this.overlays.showError(String(error)));
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
        if (!this.document.isUninitialized) this.present('gameMenu');
        break;
      case 'sectorSettings':
      case 'about':
      case 'preferences':
      case 'saveAs':
        this.present('gameMenu');
        break;
      case 'gameMenu':
        this.present(undefined);
        break;
      case undefined:
        if (this.selection.length > 0) {
          this.select([]);
        } else {
          this.present('gameMenu');
        }
        break;
    }
  }

  isOverlayPresented(): boolean {
    return this.presentedOverlay !== undefined;
  }

  save(): void {
    if (this.document.isUninitialized) return;
    void this.document.save().catch((error: unknown) => this.overlays.showError(String(error)));
  }

  presentSaveAs(): void {
    if (this.document.isUninitialized) return;
    this.present('saveAs');
  }

  undo(): void {
    this.document.undo();
  }

  redo(): void {
    this.document.redo();
  }

  /** `⌘D`: copy + paste-offset in one undo step, no clipboard round-trip. */
  duplicateSelection(): void {
    this.insert('Duplicate Selection', captureClipboard(this.selection, this.document.sector), undefined);
  }

  toggleGrid(): void {
    this.showGridOverlay = !this.showGridOverlay;
    this.refreshOverlay();
  }

  copySelection(): void {
    const captured = captureClipboard(this.selection, this.document.sector);
    if (!isClipboardEmpty(captured)) this.clipboard = captured;
  }

  /**
   * `⌘V`: appends the clones anchored at the last hovered ground point (surviving the pointer
   * leaving the canvas), falling back to a one-grid-step offset, and selects them.
   */
  paste(): void {
    this.insert('Paste', this.clipboard, this.lastHoveredGrid);
  }

  /** The one way carried records enter the document, shared by duplicate and paste. */
  private insert(actionName: string, clipboard: EditorClipboard, anchor: Point | undefined): void {
    if (isClipboardEmpty(clipboard)) return;
    let inserted: EditorSelection[] = [];
    const { accepted } = this.mutate(actionName, (sector) => {
      inserted = insertClipboard(clipboard, sector, anchor, stepOrFine(currentGridSnap()));
    });
    if (accepted) this.select(inserted);
  }

  /** `⌘A` Select All. */
  selectAll(): void {
    this.select(candidateSelections(this.document.sector));
  }

  deleteSelection(): void {
    if (this.presentedOverlay !== undefined || this.selection.length === 0) return;
    const selections = this.selection;
    this.mutate('Delete selection', (sector) => {
      removeAllSelections(selections, sector);
    });
  }

  /** Arrow-key nudge: one centimetre, or one grid step with Shift, as one undo step per press. */
  nudgeSelection(key: string, shiftHeld: boolean): boolean {
    const delta = nudgeDelta(key, shiftHeld, currentGridSnap());
    const originals = origins(this.selection, this.document.sector);
    if (delta === undefined || originals.length === 0) return false;
    this.mutate('Move selection', (sector) => {
      applyMove(originals, delta.dx, delta.dz, sector);
    });
    return true;
  }

  /** Changes the document as one undo step, surfacing a refusal in the error banner. */
  private mutate(actionName: string, change: (sector: Sector) => void, rename?: RecordRename): CommitResult {
    const result = this.document.mutate(actionName, change, rename);
    if (!result.accepted) this.overlays.showError(result.message);
    return result;
  }

  /**
   * A rename changes the identity the selection is keyed by, so the step carries it and the
   * selection follows it when the step is committed, undone, and redone.
   */
  private renameSelection(selection: EditorSelection, id: string): boolean {
    const rename = { from: selection, to: { kind: selection.kind, id } };
    return this.mutate('Rename record', (sector) => renameRecord(selection, id, sector), rename).accepted;
  }

  /** Puts a door at one of a placement's model's anchors. It leads nowhere until its target is picked. */
  private addDoor(placementId: string, anchor: string): void {
    const id = nextDoorId('', this.document.sector.doors);
    const { accepted } = this.mutate('Add door', (sector) => {
      sector.doors.push({ id, placement: placementId, anchor, target: { sector: '', door: 'exit' } });
    });
    if (accepted) this.select([{ kind: 'door', id }]);
  }

  private applySectorSettings(values: SectorSettings): void {
    // Two undo steps: the rename and the field edit are distinct actions.
    this.mutate('Rename sector', (draft) => {
      draft.name = values.name;
    });
    if (!this.mutate('Edit sector settings', (draft) => applySectorSettings(draft, values)).accepted) return;
    this.present(undefined);
  }

  private confirmDiscardIfDirty(): boolean {
    if (!this.document.isDirty) return true;
    return globalThis.confirm?.('Discard unsaved changes?') ?? true;
  }

  /**
   * Fetches every other sector the file API holds. The result belongs to the document it was
   * fetched for: one opened meanwhile runs its own fetch.
   */
  private async loadOthers(): Promise<void> {
    const name = this.document.sector.name;
    const names = (await listSectors()).filter((other) => other !== name);
    const loaded = await Promise.all(
      names.map((other) =>
        loadSector(other).catch((error: unknown) => {
          this.overlays.showError(String(error));
          return undefined;
        }),
      ),
    );
    if (this.document.sector.name !== name) return;
    this.others = loaded.filter((sector) => sector !== undefined);
    for (const neighbour of this.drawnNeighbours) this.scene.removeSector(neighbour);
    this.drawnNeighbours.clear();
    this.reconcile();
  }

  /**
   * After a document change: redraw the document's sector and the neighbours it now has, clamp
   * the selection, recompute the issues, refresh the gizmos. A reconcile during a live drag
   * means an external change invalidated the session's snapshots — the session is dropped so a
   * resumed gesture can never write into records that are gone.
   */
  private reconcile(): void {
    this.resetDragState();
    const sector = this.document.sector;
    this.selection = this.selection.filter((selection) => isValidSelection(selection, sector));
    this.issues = this.document.isUninitialized ? { error: undefined, records: [] } : documentIssues(sector, this.others, this.registry);
    this.drawSectors();
    if (!this.document.isUninitialized) this.camera.refreshFraming(sector);
    this.selectionChanged();
  }

  /** Neighbours are static, so one already drawn stays; the document's sector is rebuilt on every change. */
  private drawSectors(): void {
    const sector = this.document.sector;
    if (this.drawnDocument !== undefined && this.drawnDocument !== sector.name) this.scene.removeSector(this.drawnDocument);
    this.drawnDocument = undefined;
    const adjoining = this.document.isUninitialized ? [] : neighbours(sector, this.others);
    for (const name of [...this.drawnNeighbours]) {
      if (adjoining.some((neighbour) => neighbour.name === name)) continue;
      this.scene.removeSector(name);
      this.drawnNeighbours.delete(name);
    }
    for (const neighbour of adjoining) {
      if (this.drawnNeighbours.has(neighbour.name)) continue;
      this.scene.addSector(neighbour);
      this.drawnNeighbours.add(neighbour.name);
    }
    if (this.document.isUninitialized) return;
    this.scene.addSector(sector);
    this.drawnDocument = sector.name;
  }

  /**
   * Overlay-only refresh — the scene's sectors are left alone. While a drag is live the preview
   * body wins, so move/resize/rotate render without a commit. Also re-run on every camera
   * change: the handle extents are screen-constant points, so their size on the ground depends
   * on the live metres-per-point factor.
   */
  private refreshOverlay(): void {
    if (this.document.isUninitialized) return;
    const shown = this.dragPreview ?? this.document.sector;
    const context = this.dragContext();
    const metresPerPoint = metresPerViewportPoint(context);
    let resizeHandles: AuthoringHandleSet | undefined;
    let facingHandle: AuthoringFacingHandle | undefined;
    if (this.selection.length === 1) {
      const selected = this.selection[0]!;
      const rect = rectRecord(selected, shown);
      if (rect !== undefined) {
        resizeHandles = { centers: handleCenters(rect).map((entry) => entry.point), extent: HANDLE_DRAW_EXTENT_PT * metresPerPoint };
      }
      const turned = turnable(selected, shown, context);
      if (turned !== undefined) {
        facingHandle = {
          center: turned.center,
          handle: facingHandlePoint(turned.center, turned.reach, turned.facing, FACING_CLEARANCE_PT * metresPerPoint),
          extent: HANDLE_DRAW_EXTENT_PT * metresPerPoint,
        };
      }
    }
    this.authoringOverlay.update({
      sector: shown,
      registry: this.registry,
      issues: this.issues.records,
      selection: this.selection.map((selection) => selectionFootprint(selection, shown, this.registry)).filter((footprint) => footprint !== undefined),
      resizeHandles,
      facingHandle,
      showGrid: this.showGridOverlay,
      gridStep: currentGridSnap(),
    });
    this.labels.render(overlayLabels(shown, this.registry, this.issues.records), (point) => screenPoint(context, point));
  }

  private select(selection: EditorSelection[]): void {
    this.inspector.flushDraft();
    this.selection = selection;
    this.selectionChanged();
  }

  private selectionChanged(): void {
    const sector = this.document.sector;
    const placement = this.selection.length === 1 && this.selection[0]!.kind === 'placement' ? byId(sector.placements, this.selection[0]!.id) : undefined;
    if (placement !== undefined) this.placementModelId = placement.modelId;
    this.readout.applyBounds(this.selection, sector, this.registry);
    this.refreshOverlay();
    this.renderUI();
  }

  private renderUI(): void {
    this.palette.render(this.tool);
    this.inspector.render(this.document.sector, this.selection, this.document.isUninitialized);
    this.readout.render(this.document.sector.name);
  }

  private installHostHandlers(): void {
    window.addEventListener('resize', () => this.handleResize());
    window.addEventListener('keydown', (event) => handleEditorKeydown(this, event));
    // Explicit `⌘S` saves are the only write path, so a mis-closed tab must prompt.
    window.addEventListener('beforeunload', (event) => {
      if (!this.document.isDirty) return;
      event.preventDefault();
      // Legacy support (Chrome/Edge < 119, older WebKit): those engines gate the dialog on a
      // truthy `returnValue` rather than `preventDefault()`.
      event.returnValue = true;
    });

    this.canvas.addEventListener('pointerdown', (event) => this.handlePointerDown(event));
    this.canvas.addEventListener('pointermove', (event) => this.handlePointerMove(event));
    this.canvas.addEventListener('pointerup', (event) => this.handlePointerUp(event));
    // A cancelled pointer (palm rejection, app switch, capture loss) fires no `pointerup`, so
    // without this the drag session survives the gesture and the next move resumes it.
    this.canvas.addEventListener('pointercancel', () => this.cancelDragState());
    this.canvas.addEventListener('lostpointercapture', () => this.cancelDragState());
    this.canvas.addEventListener('pointerleave', () => {
      this.readout.x = 0;
      this.readout.z = 0;
      this.readout.render(this.document.sector.name);
    });
    this.canvas.addEventListener(
      'wheel',
      (event) => {
        if (this.presentedOverlay !== undefined) return;
        event.preventDefault();
        this.handleWheel(event);
      },
      { passive: false },
    );
  }

  /**
   * Scroll navigation, through `scrollIntent`: DOM wheel deltas are sign-opposite the
   * positive-for-up convention `scrollIntent` expects, so both axes negate at this boundary — the
   * same conversion the player session applies to its zoom.
   */
  private handleWheel(event: WheelEvent): void {
    if (this.document.isUninitialized) return;
    const intent = scrollIntent({
      deltaX: -event.deltaX,
      deltaY: -event.deltaY,
      hasPreciseDeltas: event.deltaMode === 0,
      commandHeld: event.metaKey || event.ctrlKey,
      shiftHeld: event.shiftKey,
    });
    if (intent.kind === 'zoom') {
      this.camera.zoom(wheelDeltaToZoomDelta(intent.deltaY, event.deltaMode), this.document.sector);
    } else {
      this.camera.pan(intent.delta, this.document.sector);
    }
    this.refreshOverlay();
  }

  private dragContext(): DragContext {
    return {
      camera: this.scene.camera,
      viewport: this.camera.viewportSize,
      origin: sectorOrigin(this.document.sector),
      gridStep: currentGridSnap(),
      registry: this.registry,
    };
  }

  private placementDefaults(): PlacementDefaults {
    return {
      modelId: this.placementModelId,
      floorMaterialId: this.registry.floorMaterials[0]?.id ?? '',
      characterModelId: this.registry.characterModels[0]?.id ?? '',
      monsterKind: MONSTER_KIND_IDS[0]!,
    };
  }

  private handlePointerDown(event: PointerEvent): void {
    if (event.button !== 0 || this.presentedOverlay !== undefined || this.document.isUninitialized) {
      return;
    }
    // Guarded: capture keeps a drag alive when the pointer leaves the canvas, but a
    // synthetic `PointerEvent` (test drivers) has no active pointer to capture and throws.
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      // The drag still works; it just loses the off-canvas grace.
    }
    // Before the press reads anything: the commit redraws the document and drops whatever drag
    // is in flight, and the browser would blur the field on this press anyway.
    this.inspector.flushDraft();
    this.resetDragState();
    const location = this.canvasPoint(event);
    this.dragAdditive = event.shiftKey;
    const begun = beginSession(location, this.tool, this.dragAdditive, this.document.sector, this.selection, this.dragContext());
    this.dragSession = begun.session;
    this.dragStart = location;
    if (!selectionsEqual(begun.selection, this.selection)) this.select(begun.selection);
  }

  private handlePointerMove(event: PointerEvent): void {
    const location = this.canvasPoint(event);
    if (this.presentedOverlay === undefined && !this.document.isUninitialized) {
      const grid = gridPoint(this.dragContext(), location);
      this.readout.x = grid.x;
      this.readout.z = grid.z;
      this.lastHoveredGrid = grid;
      this.readout.render(this.document.sector.name);
    }
    const session = this.dragSession;
    const start = this.dragStart;
    if (session === undefined || start === undefined) return;
    if (session.kind === 'marquee') {
      this.renderMarquee(start, location);
      return;
    }
    this.dragPreview = preview(session, start, location, this.document.sector, this.dragContext(), this.placementDefaults());
    if (this.dragPreview !== undefined && (session.kind === 'move' || session.kind === 'rotate')) this.applyLivePreview(this.dragPreview);
    this.refreshOverlay();
  }

  private handlePointerUp(event: PointerEvent): void {
    const session = this.dragSession;
    const start = this.dragStart;
    const additive = this.dragAdditive;
    const restore = this.liveNodes;
    this.resetDragState();
    if (session === undefined || start === undefined) {
      this.refreshOverlay();
      return;
    }
    const before = this.document.undoDepth;
    const committed = endSession(
      session,
      start,
      this.canvasPoint(event),
      additive,
      { mutate: (actionName, change) => this.mutate(actionName, change) },
      this.document.sector,
      this.selection,
      this.dragContext(),
      this.placementDefaults(),
    );
    // A commit redraws the sector wholesale; a drag that committed nothing (it came back to its
    // start, or the document refused it) must put the live-dragged nodes back where the document
    // says they are.
    if (this.document.undoDepth === before) restoreNodes(restore);
    if (!selectionsEqual(committed, this.selection)) {
      this.select(committed);
    } else {
      this.refreshOverlay();
    }
  }

  /**
   * The live-mesh half of a move or a turn: each selected placement's own node follows the
   * preview. Placements only — floor patches bake their texture coordinates into their
   * geometry, so their gizmo rect previews while the mesh rebuilds on commit.
   */
  private applyLivePreview(previewSector: Sector): void {
    // Snapshot the nodes and where they stood once: neither changes for the duration of the
    // drag, so resolving them on every pointer move would scan the sector's placements each frame.
    if (this.liveNodes.length === 0) {
      for (const selection of this.selection) {
        const node = selection.kind === 'placement' ? this.scene.placementNode(previewSector.name, selection.id) : undefined;
        if (node !== undefined) this.liveNodes.push({ id: selection.id, node, position: node.position.clone(), yaw: node.rotation.y });
      }
    }
    for (const { id, node } of this.liveNodes) {
      const placement = byId(previewSector.placements, id);
      if (placement === undefined) continue;
      node.position.x = placement.x;
      node.position.z = placement.z;
      node.rotation.y = THREE.MathUtils.degToRad(placement.yaw);
    }
  }

  private renderMarquee(start: { x: number; y: number }, current: { x: number; y: number }): void {
    const left = Math.min(start.x, current.x);
    const top = Math.min(start.y, current.y);
    this.marqueeNode.classList.remove('hidden');
    this.marqueeNode.style.left = `${left}px`;
    this.marqueeNode.style.top = `${top}px`;
    this.marqueeNode.style.width = `${Math.abs(current.x - start.x)}px`;
    this.marqueeNode.style.height = `${Math.abs(current.y - start.y)}px`;
  }

  private resetDragState(): void {
    this.dragSession = undefined;
    this.dragStart = undefined;
    this.dragAdditive = false;
    this.dragPreview = undefined;
    this.liveNodes = [];
    this.marqueeNode.classList.add('hidden');
  }

  /**
   * Abandons an in-flight drag without committing it — for `pointercancel`/`lostpointercapture`,
   * which fire in place of `pointerup`. Any live-dragged nodes go back to where they stood
   * first, then the session clears. Inert when no drag is active (a normal pointerup already
   * reset, and `lostpointercapture` also fires at the clean end of every drag).
   */
  private cancelDragState(): void {
    if (this.dragSession === undefined) return;
    restoreNodes(this.liveNodes);
    this.resetDragState();
  }

  private canvasPoint(event: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private aspect(): number {
    const width = this.container.clientWidth || window.innerWidth || 1;
    const height = this.container.clientHeight || window.innerHeight || 1;
    return width / height;
  }

  private startRenderer(): void {
    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = renderer;
    this.handleResize();
    void this.scene.prewarm();
    const step = (timestamp: number): void => {
      const delta = this.lastFrameMs === undefined ? 0 : (timestamp - this.lastFrameMs) / 1000;
      this.lastFrameMs = timestamp;
      this.scene.tick(Math.min(delta, 0.1));
      renderer.render(this.scene.scene, this.scene.camera);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  private handleResize(): void {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    this.renderer?.setSize(width, height, false);
    this.camera.updateViewportSize({ width, height }, this.document.sector);
    this.refreshOverlay();
  }

  recordCounts(): Record<string, number> {
    const sector = this.document.sector;
    return {
      placements: sector.placements.length,
      blockers: sector.blockers.length,
      doors: sector.doors.length,
      npcs: sector.npcs.length,
      monsterSpawns: sector.monsterSpawns.length,
      floorPatches: sector.floorPatches.length,
    };
  }
}

function restoreNodes(nodes: readonly { node: THREE.Object3D; position: THREE.Vector3; yaw: number }[]): void {
  for (const { node, position, yaw } of nodes) {
    node.position.copy(position);
    node.rotation.y = yaw;
  }
}
