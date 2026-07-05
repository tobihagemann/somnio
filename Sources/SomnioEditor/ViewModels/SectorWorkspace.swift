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

    public var placementMode: EditorPlacementMode = .object
    public var selectedPaletteSlot: PaletteSlot = .placeNew(.object)
    public var selection: EditorSelection?
    public var cursorReadout: CursorReadout = .init()
    public var presentedSheet: EditorSheetKind?
    public var didCompleteInitialSetup: Bool = false
    public var showGridOverlay: Bool = false

    /// Live canvas size reported by the hosting view. Framing and picking both read it (and
    /// `framing`) from here, so render and unprojection can never disagree on the viewport.
    public private(set) var viewportSize: CGSize = .init(width: 640, height: 480)
    /// Camera framing shared by the render and picking paths — the single source of truth
    /// `WorldScene3D.applyEditorFraming` draws with and `CanvasController` unprojects through.
    /// Starts sector-centered at the player's zoom; scroll panning and ⌘-scroll zooming
    /// adjust it (out to the whole-sector fit at most).
    public private(set) var framing: EditorFraming = .init(focus: .zero, scale: OrthographicCameraRig.defaultScale)
    /// `true` once the user pans or zooms; reconciles and viewport resizes then preserve the
    /// user's camera instead of snapping back to the whole-sector fit.
    private var hasCustomFraming = false

    public let objectForm = ObjectFormState()
    public let maskForm = MaskFormState()
    public let portalForm = PortalFormState()
    public let spawnForm = SpawnFormState()
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
        let sector = Sector(body: body, name: sectorName)
        worldScene.load(sector: sector, awaitingPlayerPlacement: false)
        refreshFraming(with: body)
        if let current = selection, !current.isValid(in: body) {
            selection = nil
        }
        cursorReadout.applyBounds(for: selection, in: body)
        refreshOverlay(with: body)
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

    /// Zooms the camera by a ⌘-scroll delta: scroll up zooms in, bounded between the player's
    /// close-up magnification and the whole-sector fit.
    public func zoomCanvas(byScrollDeltaY deltaY: CGFloat, body: SectorBody) {
        let factor = Float(exp(-deltaY * 0.02))
        hasCustomFraming = true
        applyCustomFraming(EditorFraming(focus: framing.focus, scale: framing.scale * factor), body: body)
    }

    private func applyCustomFraming(_ proposed: EditorFraming, body: SectorBody) {
        let bounds = OrthographicCameraRig.fitPixelBounds(of: body)
        let fit = OrthographicCameraRig.editorFraming(fittingPixelBounds: bounds.min, bounds.max, viewportSize: viewportVector)
        var next = proposed
        // A fit tighter than the player zoom caps the lower bound too, so a tiny sector
        // still clamps into a non-inverted range.
        let lowerBound = min(playerZoomScale, fit.scale)
        next.scale = min(max(next.scale, lowerBound), fit.scale)
        if next.scale == fit.scale {
            // Fully zoomed out, the whole sector is visible — any off-center focus (left
            // over from a pan at closer zoom) would just shove the sector against a viewport
            // edge with dead void around it, so snap to the centered fit.
            next.focus = fit.focus
        } else {
            let focusPixel = OrthographicCameraRig.legacyPoint(forWorldPosition: next.focus)
            let clamped = simd_clamp(focusPixel, bounds.min, bounds.max)
            next.focus = OrthographicCameraRig.worldPosition(forLegacyPoint: clamped)
        }
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

    /// Overlay-only refresh. Called from selection/grid `.onChange` handlers in
    /// `SectorWindowView` to avoid the full sector-graph rebuild in `reconcile`.
    public func refreshOverlay(with body: SectorBody) {
        worldScene.updateAuthoringOverlay(
            body: body,
            selectionBounds: selection?.bounds(in: body),
            showGridOverlay: showGridOverlay,
            gridStepPx: EditorDefaults.currentGridStepPx()
        )
    }

    private func refreshFraming(with body: SectorBody) {
        guard !hasCustomFraming else {
            // Keep the user's camera through document mutations and window resizes; only
            // re-clamp it so the framed extent stays reachable.
            applyCustomFraming(framing, body: body)
            return
        }
        // Open the way the player sees the world: sector-centered at the player's zoom.
        // A sector smaller than that view caps at its whole-sector fit instead.
        let fit = OrthographicCameraRig.editorFraming(fitting: body, viewportSize: viewportVector)
        framing = EditorFraming(focus: fit.focus, scale: min(playerZoomScale, fit.scale))
        worldScene.applyEditorFraming(framing)
    }
}
