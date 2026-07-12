import Foundation
import simd
import SomnioCore
import SomnioScene3D

/// Per-document UI workspace. Lives outside `SectorDocument` because the document's
/// `ReferenceFileDocument` file-API methods must be nonisolated, while the `WorldScene3D`
/// and the @Observable view state are main-actor bound. The workspace is looked up by
/// `document.id` through `SectorWorkspaceRegistry` so identity survives SwiftUI body
/// re-evaluations.
@MainActor @Observable public final class SectorWorkspace {
    public let worldScene: WorldScene3D

    public var tool: EditorTool = .select
    public var selection: Set<EditorSelection> = []
    public var cursorReadout: CursorReadout = .init()
    /// Last grid point the cursor hovered on the canvas — the paste anchor. Unlike the
    /// readout (which resets to 0 for display when the hover ends), this survives the
    /// pointer leaving the canvas so ⌘V after mousing to a panel still lands where the
    /// user last pointed. `nil` until the first hover; paste then falls back to an offset.
    public var lastHoveredGrid: GridPoint?
    public var presentedOverlay: EditorOverlayKind?
    public var didCompleteInitialSetup: Bool = false
    public var showGridOverlay: Bool = false

    /// In-flight drag interaction, classified by `DragController.beginSession` on the first
    /// gesture change and consumed on gesture end. `nil` outside a drag.
    public var dragSession: EditorDragSession?
    /// Whether the live drag started with Shift held — marquee then extends the selection
    /// instead of replacing it.
    public var dragAdditive: Bool = false
    /// Transient sector body shown while a drag is live: the overlay renders the moved/resized
    /// geometry without touching the document or the undo stack. Cleared on gesture end (the
    /// committed `mutate` then triggers the real `reconcile`).
    public var dragPreview: SectorBody?
    /// Viewport-space rubber band of a live marquee drag, drawn by the interaction layer.
    public var marqueeRect: CGRect?

    /// Live canvas size reported by the hosting view. Framing and picking both read it (and
    /// `framing`) from here, so render and unprojection can never disagree on the viewport.
    public private(set) var viewportSize: CGSize = .init(width: 640, height: 480)
    /// Camera framing shared by the render and picking paths — the single source of truth
    /// `WorldScene3D.applyEditorFraming` draws with and `CanvasController` unprojects through.
    /// Starts sector-centered at the player's zoom; scroll panning and ⌘-scroll zooming
    /// adjust it with the game's own zoom mechanics.
    public private(set) var framing: EditorFraming = .init(focus: .zero, scale: OrthographicCameraRig.defaultScale)
    /// `true` once the user pans or zooms; reconciles and viewport resizes then preserve the
    /// user's camera instead of snapping back to the opening framing.
    private var hasCustomFraming = false
    /// The game's interactive zoom, reused verbatim: a clamped 0.5×–2× multiplicative
    /// factor over the player-parity framing, so the editor's ⌘-scroll feels exactly like
    /// the player's scroll zoom.
    private var playerZoom = PlayerZoom()

    public let newMapForm = NewMapFormState()

    public init() {
        let scene = WorldScene3D()
        self.worldScene = scene
        // Warm the model cache like the player client's app entry — anything placed before
        // this finishes renders a placeholder and is re-resolved in place when it completes.
        Task {
            await scene.prewarmModels()
        }
    }

    /// Full reload after a document mutation: swap the rendered sector graph, re-fit the
    /// camera, clamp the active selection against the new array bounds, then refresh the
    /// authoring overlay. Heavy because `load(sector:)` rebuilds the whole sector subtree;
    /// selection/grid-only changes should use `refreshOverlay(with:)` instead.
    public func reconcile(with body: SectorBody, sectorName: String) {
        // A reconcile during a live drag means an external mutation (undo, a menu
        // command) invalidated the session's snapshotted indices — drop the session so a
        // resumed gesture can never mutate re-indexed records. Gesture-end commits are
        // unaffected: the view clears its drag state before committing.
        dragSession = nil
        dragPreview = nil
        marqueeRect = nil
        dragAdditive = false
        let sector = Sector(body: body, name: sectorName)
        worldScene.load(sector: sector, awaitingPlayerPlacement: false)
        refreshFraming(with: body)
        selection = selection.filter { $0.isValid(in: body) }
        cursorReadout.applyBounds(for: selection, in: body)
        refreshOverlay(with: body)
    }

    /// Single Esc owner, invoked by the window-level key monitor (mirroring the player
    /// client's `handleEscape` state table): a presented overlay backs out one level toward
    /// the game menu, a live selection clears, and live editing opens the game menu. The
    /// new-map overlay over an uninitialized document is the floor — there is nothing behind
    /// it, so Esc there is a consumed no-op.
    public func handleEscape(documentIsUninitialized: Bool) {
        switch presentedOverlay {
        case .newMap:
            if !documentIsUninitialized {
                presentedOverlay = .gameMenu
            }
        case .sectorSettings, .about:
            presentedOverlay = .gameMenu
        case .gameMenu:
            presentedOverlay = nil
        case nil:
            if !selection.isEmpty {
                selection = []
            } else {
                presentedOverlay = .gameMenu
            }
        }
    }

    /// Reports a canvas size change from the hosting view and re-fits the camera to it.
    public func updateViewportSize(_ size: CGSize, body: SectorBody) {
        guard size.width > 0, size.height > 0, size != viewportSize else { return }
        viewportSize = size
        refreshFraming(with: body)
    }

    /// Pans the camera by a scroll delta in viewport points: content follows the scroll, so
    /// the framing focus moves to where the shifted viewport center lands on the floor,
    /// clamped to the whole-sector fit extent.
    public func panCanvas(byViewportDelta delta: CGSize, body: SectorBody) {
        let shifted = viewportVector / 2 - SIMD2<Float>(delta)
        let focusPixel = OrthographicCameraRig.legacyPoint(
            forViewport: shifted,
            viewportSize: viewportVector,
            framing: framing
        )
        hasCustomFraming = true
        applyCustomFraming(EditorFraming(
            focus: OrthographicCameraRig.worldPosition(forLegacyPoint: focusPixel),
            scale: framing.scale
        ), body: body)
    }

    /// Zooms the camera by a ⌘-scroll delta through the game's own `PlayerZoom` — the same
    /// clamped multiplicative factor and scroll gain the player viewport uses, applied over
    /// the player-parity framing for this canvas height.
    public func zoomCanvas(byScrollDeltaY deltaY: CGFloat, body: SectorBody) {
        hasCustomFraming = true
        playerZoom.applyScroll(deltaY: deltaY)
        applyCustomFraming(EditorFraming(focus: framing.focus, scale: playerZoomScale / Float(playerZoom.factor)), body: body)
    }

    /// Clamps the focus onto the sector's fit extent (no panning off into the void) and
    /// applies the framing. The scale arrives pre-clamped — `PlayerZoom` bounds the zoom
    /// exactly like the player's viewport.
    private func applyCustomFraming(_ proposed: EditorFraming, body: SectorBody) {
        let bounds = OrthographicCameraRig.fitPixelBounds(of: body)
        var next = proposed
        let focusPixel = OrthographicCameraRig.legacyPoint(forWorldPosition: next.focus)
        let clamped = simd_clamp(focusPixel, bounds.min, bounds.max)
        next.focus = OrthographicCameraRig.worldPosition(forLegacyPoint: clamped)
        framing = next
        worldScene.applyEditorFraming(next)
    }

    private var viewportVector: SIMD2<Float> {
        SIMD2<Float>(viewportSize)
    }

    /// The scale reproducing the player's default magnification on this canvas — the
    /// editor's opening zoom and the ⌘-scroll zoom-in bound.
    private var playerZoomScale: Float {
        OrthographicCameraRig.playerZoomScale(forViewportHeight: Float(viewportSize.height))
    }

    /// Legacy pixels covered by one viewport point at the live framing — sizes the resize
    /// and facing handles so they keep a constant screen extent across zoom levels, and
    /// matches the drag layer's projected hit-test rects by construction.
    public var legacyPixelsPerViewportPoint: Float {
        DragController.legacyPixelsPerViewportPoint(viewportSize: viewportSize, framing: framing)
    }

    /// Overlay-only refresh. Called from selection/grid `.onChange` handlers in
    /// `SectorWindowView` to avoid the full sector-graph rebuild in `reconcile`. While a
    /// drag is live the preview body wins, so move/resize/rotate render without a mutate.
    public func refreshOverlay(with body: SectorBody) {
        let shown = dragPreview ?? body
        let pxPerPt = legacyPixelsPerViewportPoint
        var resizeHandles: AuthoringHandleSet?
        var facingHandle: AuthoringFacingHandle?
        if selection.count == 1, let selected = selection.first {
            // Singleton affordances: resize handles at the drag layer's own hit-test
            // centers, plus the facing handle for an NPC.
            if let bounds = selected.bounds(in: shown) {
                resizeHandles = AuthoringHandleSet(
                    centerPixels: DragController.handleCenters(origin: bounds.origin, size: bounds.size).map(\.pixel),
                    extentPx: Float(DragController.handleDrawExtentPt) * pxPerPt
                )
            }
            if case let .npc(index) = selected, shown.npcs.indices.contains(index) {
                let npc = shown.npcs[index]
                facingHandle = AuthoringFacingHandle(
                    centerPixel: DragController.spawnBoxCenter(origin: npc.spawnOrigin, size: npc.spawnBoxSize),
                    handlePixel: DragController.facingHandlePixel(
                        origin: npc.spawnOrigin, size: npc.spawnBoxSize, heading: npc.facing,
                        clearancePx: Float(DragController.facingClearancePt) * pxPerPt
                    ),
                    extentPx: Float(DragController.handleDrawExtentPt) * pxPerPt
                )
            }
        }
        worldScene.updateAuthoringOverlay(
            body: shown,
            selectionBounds: selection.compactMap { $0.bounds(in: shown) },
            resizeHandles: resizeHandles,
            facingHandle: facingHandle,
            showGridOverlay: showGridOverlay,
            gridStepPx: EditorDefaults.currentGridStepPx()
        )
    }

    private func refreshFraming(with body: SectorBody) {
        guard !hasCustomFraming else {
            // Keep the user's camera through document mutations and window resizes; only
            // re-clamp the focus so the framed extent stays reachable.
            applyCustomFraming(framing, body: body)
            return
        }
        // Open the way the player sees the world: sector-centered at the player's zoom.
        let fit = OrthographicCameraRig.editorFraming(fitting: body, viewportSize: viewportVector)
        framing = EditorFraming(focus: fit.focus, scale: playerZoomScale / Float(playerZoom.factor))
        worldScene.applyEditorFraming(framing)
    }
}
