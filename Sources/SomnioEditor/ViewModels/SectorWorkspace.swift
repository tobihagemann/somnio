import Foundation
import SomnioCore
import SomnioUI

/// Per-document UI workspace. Lives outside `SectorDocument` because the document's
/// `ReferenceFileDocument` file-API methods must be nonisolated, while the `WorldScene`
/// and the @Observable view state are main-actor bound. The workspace is looked up by
/// `document.id` through `SectorWorkspaceRegistry` so identity survives SwiftUI body
/// re-evaluations.
@MainActor @Observable public final class SectorWorkspace {
    public let worldScene: WorldScene
    public let overlayLayer: EditorOverlayLayer

    public var placementMode: EditorPlacementMode = .object
    public var selectedPaletteSlot: PaletteSlot = .placeNew(.object)
    public var selection: EditorSelection?
    public var cursorReadout: CursorReadout = .init()
    public var presentedSheet: EditorSheetKind?
    public var didCompleteInitialSetup: Bool = false
    public var showGridOverlay: Bool = false

    public let objectForm = ObjectFormState()
    public let maskForm = MaskFormState()
    public let portalForm = PortalFormState()
    public let spawnForm = SpawnFormState()
    public let newMapForm = NewMapFormState()

    public init() {
        let assets = BundleMainSpriteAssets()
        let scene = WorldScene(size: CGSize(width: 640, height: 480), assets: assets)
        self.worldScene = scene
        let overlay = EditorOverlayLayer()
        self.overlayLayer = overlay
        scene.addChild(overlay.rootNode)
    }

    /// Full reload after a document mutation: swap the SpriteKit scene's tile/object
    /// layer, clamp the active selection against the new array bounds, then refresh
    /// the overlay. Heavy because `WorldScene.load(sector:)` rebuilds the entire tile
    /// graph; selection/grid-only changes should use `refreshOverlay(with:)` instead.
    public func reconcile(with body: SectorBody, sectorName: String) {
        worldScene.load(sector: Sector(body: body, name: sectorName))
        if let current = selection, !current.isValid(in: body) {
            selection = nil
        }
        cursorReadout.applyBounds(for: selection, in: body)
        refreshOverlay(with: body)
    }

    /// Overlay-only refresh. Called from selection/grid `.onChange` handlers in
    /// `SectorWindowView` to avoid the full tile-graph rebuild in `reconcile`.
    public func refreshOverlay(with body: SectorBody) {
        overlayLayer.refresh(
            with: body,
            selection: selection,
            showGridOverlay: showGridOverlay,
            gridStepPx: EditorDefaults.currentGridStepPx()
        )
    }
}
