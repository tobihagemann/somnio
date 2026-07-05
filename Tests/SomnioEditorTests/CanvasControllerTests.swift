import CoreGraphics
import simd
import SomnioCore
import Testing
@testable import SomnioEditor
@testable import SomnioScene3D

@MainActor
struct CanvasControllerTests {
    private static let viewportSize = CGSize(width: 640, height: 480)

    private func framing(minPixel: SIMD2<Float> = .zero, maxPixel: SIMD2<Float> = SIMD2<Float>(512, 512)) -> EditorFraming {
        OrthographicCameraRig.editorFraming(
            fittingPixelBounds: minPixel, maxPixel,
            viewportSize: SIMD2<Float>(Float(Self.viewportSize.width), Float(Self.viewportSize.height))
        )
    }

    /// Viewport point where a legacy pixel lands under the framing — the tap location a user
    /// aiming at that pixel would produce.
    private func viewportPoint(forPixel pixel: SIMD2<Float>, framing: EditorFraming) -> CGPoint {
        let point = OrthographicCameraRig.viewportPoint(
            forLegacyPoint: pixel,
            viewportSize: SIMD2<Float>(Float(Self.viewportSize.width), Float(Self.viewportSize.height)),
            framing: framing
        )
        return CGPoint(x: CGFloat(point.x), y: CGFloat(point.y))
    }

    @Test func `a tap at a pixel's projected viewport point resolves to that grid cell`() {
        // Mid-pixel targets, as real taps are: the unprojection floors to the containing
        // pixel, matching the retired 2D canvas's downward rounding.
        let framing = framing()
        let tap = viewportPoint(forPixel: SIMD2<Float>(128.5, 96.5), framing: framing)
        let grid = CanvasController.gridPoint(forViewport: tap, viewportSize: Self.viewportSize, framing: framing)
        #expect(grid == GridPoint(x: 128, y: 96))
    }

    @Test func `a tap inside an overflow footprint resolves to negative coordinates`() {
        // A shelf row authored at y = -48 is inside the fit; picking it must yield the
        // authored negative coordinate rather than clamping to the sector rect.
        let framing = framing(minPixel: SIMD2<Float>(0, -48))
        let tap = viewportPoint(forPixel: SIMD2<Float>(32.5, -40.5), framing: framing)
        let grid = CanvasController.gridPoint(forViewport: tap, viewportSize: Self.viewportSize, framing: framing)
        #expect(grid == GridPoint(x: 32, y: -41))
    }

    @Test func `fractional pixels floor downward like the retired pixel canvas`() {
        let framing = framing()
        let tap = viewportPoint(forPixel: SIMD2<Float>(200.9, 300.4), framing: framing)
        let grid = CanvasController.gridPoint(forViewport: tap, viewportSize: Self.viewportSize, framing: framing)
        #expect(grid == GridPoint(x: 200, y: 300))
    }

    @Test func `a tap outside the sector bounds resolves without trapping`() {
        // The hit-catcher covers the whole viewport, so a corner tap unprojects to a floor
        // point outside the fitted sector rect (the floor is a rotated diamond in view space);
        // the dispatch then finds no record there and no-ops rather than crashing.
        let framing = framing()
        let grid = CanvasController.gridPoint(forViewport: .zero, viewportSize: Self.viewportSize, framing: framing)
        let insideSector = (0 ..< 512).contains(Int(grid.x)) && (0 ..< 512).contains(Int(grid.y))
        #expect(!insideSector)
    }

    @Test func `command scroll routes to zoom with line deltas scaled`() {
        #expect(CanvasController.scrollIntent(
            deltaX: 0, deltaY: 3, hasPreciseDeltas: false, commandHeld: true, shiftHeld: false
        ) == .zoom(deltaY: 30))
        #expect(CanvasController.scrollIntent(
            deltaX: 0, deltaY: 3, hasPreciseDeltas: true, commandHeld: true, shiftHeld: false
        ) == .zoom(deltaY: 3))
    }

    @Test func `plain scroll routes to a two-axis pan`() {
        #expect(CanvasController.scrollIntent(
            deltaX: 4, deltaY: -2, hasPreciseDeltas: true, commandHeld: false, shiftHeld: false
        ) == .pan(delta: CGSize(width: 4, height: -2)))
    }

    @Test func `shift turns a mouse wheel's vertical ticks horizontal`() {
        #expect(CanvasController.scrollIntent(
            deltaX: 0, deltaY: 2, hasPreciseDeltas: false, commandHeld: false, shiftHeld: true
        ) == .pan(delta: CGSize(width: 20, height: 0)))
        // A trackpad already pans both axes; Shift must not clobber a real horizontal delta.
        #expect(CanvasController.scrollIntent(
            deltaX: 3, deltaY: 2, hasPreciseDeltas: true, commandHeld: false, shiftHeld: true
        ) == .pan(delta: CGSize(width: 3, height: 2)))
    }

    @Test func `the unprojected pixel quantizes with the unchanged grid snap`() {
        // The pre-pivot path was floor-then-quantize; the unprojection replaces only the
        // floor half, so quantize(128 px tap, 32 px step) still snaps to 128.
        let framing = framing()
        let tap = viewportPoint(forPixel: SIMD2<Float>(140.5, 70.5), framing: framing)
        let grid = CanvasController.gridPoint(forViewport: tap, viewportSize: Self.viewportSize, framing: framing)
        #expect(EditorDefaults.quantize(grid.x, step: 32) == 128)
        #expect(EditorDefaults.quantize(grid.y, step: 32) == 64)
    }
}
