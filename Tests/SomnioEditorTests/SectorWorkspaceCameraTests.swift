import CoreGraphics
import simd
import SomnioCore
import SomnioScene3D
import Testing
@testable import SomnioEditor

/// Canvas navigation math on the workspace: the player-zoom opening framing, scroll panning,
/// ⌘-scroll zooming, and the custom-camera persistence across reconciles that would otherwise
/// snap back.
@MainActor
struct SectorWorkspaceCameraTests {
    private func body(objects: [Object] = []) -> SectorBody {
        SectorBody(
            version: 1,
            dimensions: GridSize(width: 12, height: 12),
            floorMaterialID: "grass-meadow",
            light: LightSetting(indoor: false, brightness: 100),
            objects: objects
        )
    }

    private func workspace(with body: SectorBody) -> SectorWorkspace {
        let workspace = SectorWorkspace()
        workspace.reconcile(with: body, sectorName: "Test")
        return workspace
    }

    private func fitFraming(for body: SectorBody, workspace: SectorWorkspace) -> EditorFraming {
        OrthographicCameraRig.editorFraming(
            fitting: body,
            viewportSize: SIMD2<Float>(workspace.viewportSize)
        )
    }

    @Test func `the editor opens sector-centered at the player's zoom`() {
        let body = body()
        let workspace = workspace(with: body)
        // The default 480 pt canvas matches the play field, so the opening scale IS the
        // game's default close-up; the focus is the whole-sector fit's center.
        #expect(workspace.framing.scale == OrthographicCameraRig.defaultScale)
        #expect(workspace.framing.focus == fitFraming(for: body, workspace: workspace).focus)
    }

    @Test func `zooming out stops at the whole-sector fit and re-centers`() {
        let body = body()
        let workspace = workspace(with: body)
        // Pan off-center first: at full zoom-out an off-center focus would shove the sector
        // against a viewport edge, so reaching the fit scale must restore the centered fit.
        workspace.panCanvas(byViewportDelta: CGSize(width: 200, height: 200), body: body)
        workspace.zoomCanvas(byScrollDeltaY: -500, body: body)
        #expect(workspace.framing == fitFraming(for: body, workspace: workspace))
    }

    @Test func `zooming back in stops at the player's zoom`() {
        let body = body()
        let workspace = workspace(with: body)
        workspace.zoomCanvas(byScrollDeltaY: -500, body: body)
        workspace.zoomCanvas(byScrollDeltaY: 2000, body: body)
        #expect(workspace.framing.scale == OrthographicCameraRig.defaultScale)
    }

    @Test func `panning moves the focus and clamps to the fit extent`() {
        let body = body()
        let workspace = workspace(with: body)
        let opening = workspace.framing
        // Pin the pan's direction and magnitude, not just "it moved": the focus must land on
        // the floor point the shifted viewport center unprojects to — a sign flip or axis
        // swap in the pan wiring would land elsewhere and still pass a mere inequality.
        let viewport = SIMD2<Float>(workspace.viewportSize)
        let expected = OrthographicCameraRig.legacyPoint(
            forViewport: viewport / 2 - SIMD2<Float>(0, 120),
            viewportSize: viewport,
            framing: opening
        )
        workspace.panCanvas(byViewportDelta: CGSize(width: 0, height: 120), body: body)
        let panned = OrthographicCameraRig.legacyPoint(forWorldPosition: workspace.framing.focus)
        #expect(length(panned - expected) < 0.01)
        #expect(workspace.framing.focus != opening.focus)
        // A huge pan pins the focus to the fit-extent edge instead of leaving the sector.
        workspace.panCanvas(byViewportDelta: CGSize(width: 100_000, height: 100_000), body: body)
        let bounds = OrthographicCameraRig.fitPixelBounds(of: body)
        let focusPixel = OrthographicCameraRig.legacyPoint(forWorldPosition: workspace.framing.focus)
        #expect(focusPixel.x >= bounds.min.x - 0.01 && focusPixel.x <= bounds.max.x + 0.01)
        #expect(focusPixel.y >= bounds.min.y - 0.01 && focusPixel.y <= bounds.max.y + 0.01)
    }

    @Test func `a viewport resize keeps the player's magnification`() {
        let body = body()
        let workspace = workspace(with: body)
        // A taller canvas shows more world at the same meters-per-point: the opening scale
        // tracks the viewport height so models stay exactly as large as the player renders them.
        workspace.updateViewportSize(CGSize(width: 1280, height: 960), body: body)
        #expect(workspace.viewportSize == CGSize(width: 1280, height: 960))
        #expect(workspace.framing.scale == OrthographicCameraRig.playerZoomScale(forViewportHeight: 960))
        #expect(workspace.framing.focus == fitFraming(for: body, workspace: workspace).focus)
    }

    @Test func `a viewport resize preserves the user's pan and zoom`() {
        let body = body()
        let workspace = workspace(with: body)
        workspace.zoomCanvas(byScrollDeltaY: -100, body: body)
        workspace.panCanvas(byViewportDelta: CGSize(width: 40, height: 40), body: body)
        let custom = workspace.framing
        workspace.updateViewportSize(CGSize(width: 1280, height: 480), body: body)
        #expect(workspace.framing == custom)
    }

    @Test func `a degenerate or unchanged viewport size is ignored`() {
        let body = body()
        let workspace = workspace(with: body)
        let before = workspace.framing
        workspace.updateViewportSize(.zero, body: body)
        workspace.updateViewportSize(workspace.viewportSize, body: body)
        #expect(workspace.framing == before)
    }

    @Test func `a reconcile preserves the user's pan and zoom`() {
        let body = body()
        let workspace = workspace(with: body)
        workspace.zoomCanvas(byScrollDeltaY: -100, body: body)
        workspace.panCanvas(byViewportDelta: CGSize(width: 40, height: 40), body: body)
        let custom = workspace.framing
        workspace.reconcile(with: body, sectorName: "Test")
        #expect(workspace.framing == custom)
    }

    @Test func `without user navigation a reconcile keeps the opening framing`() {
        let body = body()
        let workspace = workspace(with: body)
        let opening = workspace.framing
        workspace.reconcile(with: body, sectorName: "Test")
        #expect(workspace.framing == opening)
    }

    @Test func `a sector smaller than the player view opens at its whole-sector fit`() {
        let tiny = SectorBody(
            version: 1,
            dimensions: GridSize(width: 1, height: 1),
            floorMaterialID: "grass-meadow",
            light: LightSetting(indoor: false, brightness: 100)
        )
        let workspace = workspace(with: tiny)
        let fit = fitFraming(for: tiny, workspace: workspace)
        #expect(fit.scale < OrthographicCameraRig.defaultScale)
        #expect(workspace.framing.scale == fit.scale)
        // The zoom-in bound drops to the fit too, so the clamp range stays non-inverted:
        // zooming can neither pass the fit nor reach the (larger) player zoom.
        workspace.zoomCanvas(byScrollDeltaY: 500, body: tiny)
        #expect(workspace.framing.scale == fit.scale)
        workspace.zoomCanvas(byScrollDeltaY: -500, body: tiny)
        #expect(workspace.framing.scale == fit.scale)
    }
}
