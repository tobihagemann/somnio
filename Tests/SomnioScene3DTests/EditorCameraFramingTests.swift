import Foundation
import simd
import SomnioCore
import SomnioMapFixturesTestSupport
import Testing
@testable import SomnioScene3D

/// Coordinate-preservation guards for the editor's camera framing + picking math: the
/// project→unproject round-trip, the whole-sector fit (including footprints past the sector
/// edge), and the fit's independence from the gameplay zoom clamp.
struct EditorCameraFramingTests {
    private static let viewport = SIMD2<Float>(640, 480)

    private func framing(minPixel: SIMD2<Float> = .zero, maxPixel: SIMD2<Float>, viewport: SIMD2<Float> = viewport) -> EditorFraming {
        OrthographicCameraRig.editorFraming(fittingPixelBounds: minPixel, maxPixel, viewportSize: viewport)
    }

    @Test(arguments: [
        SIMD2<Float>(0, 0),
        SIMD2<Float>(128.5, 96.5),
        SIMD2<Float>(511, 511),
        SIMD2<Float>(-64, -48),
        SIMD2<Float>(200.9, 300.4)
    ])
    func `project then unproject returns the same legacy pixel`(pixel: SIMD2<Float>) {
        let framing = framing(maxPixel: SIMD2<Float>(512, 512))
        let viewportPoint = OrthographicCameraRig.viewportPoint(
            forLegacyPoint: pixel, viewportSize: Self.viewport, framing: framing
        )
        let restored = OrthographicCameraRig.legacyPoint(
            forViewport: viewportPoint, viewportSize: Self.viewport, framing: framing
        )
        #expect(length(restored - pixel) < 0.1)
    }

    @Test func `the viewport center unprojects to the framed bounds center`() {
        let framing = framing(maxPixel: SIMD2<Float>(512, 512))
        let center = OrthographicCameraRig.legacyPoint(
            forViewport: Self.viewport / 2, viewportSize: Self.viewport, framing: framing
        )
        #expect(length(center - SIMD2<Float>(256, 256)) < 0.1)
    }

    /// Extreme aspects alongside the play-field default: the fit's `horizontalExtent / aspect`
    /// branch must hold in very wide and very tall editor windows, not just at 4:3.
    private static let fitViewports = [
        SIMD2<Float>(640, 480),
        SIMD2<Float>(1600, 400),
        SIMD2<Float>(400, 1200)
    ]

    @Test(arguments: MapFixtures.Name.allCases, fitViewports)
    func `every fixture's floor and object footprints project inside the viewport`(
        name: MapFixtures.Name,
        viewport: SIMD2<Float>
    ) throws {
        let body = try MapCodec.read(MapFixtures.data(name))
        let framing = OrthographicCameraRig.editorFraming(fitting: body, viewportSize: viewport)
        var extremes = [
            SIMD2<Float>(0, 0),
            SIMD2<Float>(Float(body.pixelWidth), 0),
            SIMD2<Float>(0, Float(body.pixelHeight)),
            SIMD2<Float>(Float(body.pixelWidth), Float(body.pixelHeight))
        ]
        for object in body.objects {
            let origin = SIMD2<Float>(Float(object.x), Float(object.y))
            let far = origin + SIMD2<Float>(Float(object.sourceWidth), Float(object.sourceHeight))
            extremes.append(origin)
            extremes.append(far)
            extremes.append(SIMD2<Float>(origin.x, far.y))
            extremes.append(SIMD2<Float>(far.x, origin.y))
        }
        let tolerance: Float = 0.01
        for pixel in extremes {
            let projected = OrthographicCameraRig.viewportPoint(
                forLegacyPoint: pixel, viewportSize: viewport, framing: framing
            )
            #expect(projected.x >= -tolerance && projected.x <= viewport.x + tolerance)
            #expect(projected.y >= -tolerance && projected.y <= viewport.y + tolerance)
        }
    }

    @Test func `the whole-sector fit is not clamped to the gameplay zoom bounds`() {
        // A 24×24-tile sector spans 3072 px ≈ 61 m — its fit half-height must exceed the
        // play-zoom `maxScale` (24) instead of cropping to it.
        let body = SectorBody(
            version: 1,
            dimensions: GridSize(width: 24, height: 24),
            floorMaterialID: "grass-meadow",
            light: LightSetting(indoor: false, brightness: 100)
        )
        let framing = OrthographicCameraRig.editorFraming(fitting: body, viewportSize: Self.viewport)
        #expect(framing.scale > OrthographicCameraRig.maxScale)
    }

    @Test func `object footprints past the sector edge widen the fit`() {
        // The library's north shelf row is authored at y = -48; the fit must include it, so
        // its framing is strictly wider than the bare floor rect's.
        let bare = framing(maxPixel: SIMD2<Float>(512, 512))
        let widened = framing(minPixel: SIMD2<Float>(0, -48), maxPixel: SIMD2<Float>(512, 512))
        #expect(widened.scale > bare.scale)
        let shelfCorner = OrthographicCameraRig.viewportPoint(
            forLegacyPoint: SIMD2<Float>(0, -48), viewportSize: Self.viewport, framing: widened
        )
        #expect(shelfCorner.x >= 0 && shelfCorner.y >= 0)
    }

    @Test func `a degenerate viewport falls back to the default scale`() {
        let framing = framing(maxPixel: SIMD2<Float>(512, 512), viewport: .zero)
        #expect(framing.scale == OrthographicCameraRig.defaultScale)
    }

    @Test func `the player zoom scale tracks viewport height and guards a degenerate one`() {
        // Same magnification as the play field: twice the height shows twice the world.
        #expect(OrthographicCameraRig.playerZoomScale(forViewportHeight: 480) == OrthographicCameraRig.defaultScale)
        #expect(OrthographicCameraRig.playerZoomScale(forViewportHeight: 960) == OrthographicCameraRig.defaultScale * 2)
        #expect(OrthographicCameraRig.playerZoomScale(forViewportHeight: 0) == OrthographicCameraRig.defaultScale)
    }

    @Test func `unprojection lands on the floor plane the renderer places on`() {
        // The unprojected pixel must agree with `worldPosition(forLegacyPoint:)` — the same
        // mapping `WorldScene3D` renders through — or picking drifts from what's drawn.
        let framing = framing(maxPixel: SIMD2<Float>(512, 512))
        let pixel = SIMD2<Float>(300.5, 200.5)
        let viewportPoint = OrthographicCameraRig.viewportPoint(
            forLegacyPoint: pixel, viewportSize: Self.viewport, framing: framing
        )
        let restored = OrthographicCameraRig.legacyPoint(
            forViewport: viewportPoint, viewportSize: Self.viewport, framing: framing
        )
        let world = OrthographicCameraRig.worldPosition(forLegacyPoint: restored)
        let expected = OrthographicCameraRig.worldPosition(forLegacyPoint: pixel)
        #expect(length(world - expected) < 0.01)
        #expect(world.y == 0)
    }
}
