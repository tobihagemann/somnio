import CoreGraphics
import Foundation
import simd
import SomnioCore

/// Bridges the SwiftUI/AppKit side's `CGSize`/`CGPoint` to the rig's `SIMD2<Float>` vocabulary
/// in one place, so the picking and framing seams don't hand-write the conversion per call site.
public extension SIMD2 where Scalar == Float {
    init(_ size: CGSize) {
        self.init(Float(size.width), Float(size.height))
    }

    init(_ point: CGPoint) {
        self.init(Float(point.x), Float(point.y))
    }
}

/// One camera framing (focus point + orthographic scale) shared by the editor's render and
/// picking paths. The editor computes it once per sector/viewport change and hands the same
/// value to `WorldScene3D.applyEditorFraming(_:)` and to the unprojection — if the two paths
/// derived framing independently, picking would silently drift from what's drawn.
public struct EditorFraming: Sendable, Equatable {
    public var focus: SIMD3<Float>
    public var scale: Float

    public init(focus: SIMD3<Float>, scale: Float) {
        self.focus = focus
        self.scale = scale
    }
}

/// Camera-plane basis for the fixed pitch + yaw, matching `lookRotation`'s axes: `right` and
/// `up` span the orthographic view plane, `forward` points from the camera toward the floor.
struct CameraBasis {
    var right: SIMD3<Float>
    var up: SIMD3<Float>
    var forward: SIMD3<Float>
}

/// Pure whole-sector framing + viewport unprojection for the editor, kept RealityKit-free like
/// the rest of the rig so the math is headlessly unit-testable. The editor's fit scale is NOT
/// clamped to the gameplay `minScale`/`maxScale` — those bound interactive play zoom, and a
/// whole-sector fit for even the 12×12 fixture exceeds `maxScale` under the tilted camera.
public extension OrthographicCameraRig {
    internal static func cameraBasis() -> CameraBasis {
        let zAxis = offsetDirection()
        let xAxis = normalize(cross(SIMD3<Float>(0, 1, 0), zAxis))
        let yAxis = cross(zAxis, xAxis)
        return CameraBasis(right: xAxis, up: yAxis, forward: -zAxis)
    }

    /// Play-field height `defaultScale` is tuned against — the player's fixed 640×480 viewport.
    static let playerViewportHeight: Float = 480

    /// The orthographic scale that reproduces the player's default close-up magnification
    /// (world meters per viewport point) in a viewport of the given height, so the editor can
    /// open a sector looking exactly as zoomed as the game renders it.
    static func playerZoomScale(forViewportHeight height: Float) -> Float {
        guard height > 0 else { return defaultScale }
        return defaultScale * height / playerViewportHeight
    }

    /// Framing that fits the whole sector — the floor rect plus every authored object
    /// footprint, so props at negative/overflow coordinates stay framed and selectable —
    /// into a viewport of the given size.
    static func editorFraming(fitting body: SectorBody, viewportSize: SIMD2<Float>) -> EditorFraming {
        let bounds = fitPixelBounds(of: body)
        return editorFraming(fittingPixelBounds: bounds.min, bounds.max, viewportSize: viewportSize)
    }

    /// Framing that fits a legacy-pixel bounding rect (top-left `minPixel`, bottom-right
    /// `maxPixel`) into the viewport. The rect lies on the floor plane, where the camera-plane
    /// projection is linear in pixel coordinates, so the projected extremes land on the rect
    /// corners and the projected center is the rect center.
    static func editorFraming(
        fittingPixelBounds minPixel: SIMD2<Float>,
        _ maxPixel: SIMD2<Float>,
        viewportSize: SIMD2<Float>
    ) -> EditorFraming {
        let basis = cameraBasis()
        let corners = [
            SIMD2<Float>(minPixel.x, minPixel.y),
            SIMD2<Float>(maxPixel.x, minPixel.y),
            SIMD2<Float>(minPixel.x, maxPixel.y),
            SIMD2<Float>(maxPixel.x, maxPixel.y)
        ].map { worldPosition(forLegacyPoint: $0) }
        let horizontal = corners.map { dot($0, basis.right) }
        let vertical = corners.map { dot($0, basis.up) }
        let horizontalExtent = (horizontal.max() ?? 0) - (horizontal.min() ?? 0)
        let verticalExtent = (vertical.max() ?? 0) - (vertical.min() ?? 0)
        let focus = worldPosition(forLegacyPoint: (minPixel + maxPixel) / 2)
        guard viewportSize.x > 0, viewportSize.y > 0 else {
            return EditorFraming(focus: focus, scale: defaultScale)
        }
        let aspect = viewportSize.x / viewportSize.y
        // Halved because `scale` is the view volume's vertical half-height (see
        // `legacyPoint(forViewport:)`): the fit scale renders exactly the rect's extent.
        let fit = max(verticalExtent, horizontalExtent / aspect) / 2
        return EditorFraming(focus: focus, scale: fit > 0 ? fit : defaultScale)
    }

    /// Unprojects a top-left-origin viewport point through the fixed orthographic camera at
    /// `framing`, intersects the floor plane (Y = 0), and returns the legacy pixel coordinate —
    /// the inverse of `worldPosition(forLegacyPoint:)` for the editor's picking path.
    ///
    /// RealityKit's `OrthographicCameraComponent.scale` is the view volume's vertical
    /// HALF-height (SceneKit's `orthographicScale` convention): the render spans `2 × scale`
    /// meters vertically. Treating it as the full height made every unprojection overshoot
    /// the drawn geometry by exactly 2× from the view center — measured against the live
    /// render — so the NDC→camera-plane mapping here (and its inverse below) must scale by
    /// `framing.scale` per half-axis, not `framing.scale / 2`.
    static func legacyPoint(
        forViewport point: SIMD2<Float>,
        viewportSize: SIMD2<Float>,
        framing: EditorFraming
    ) -> SIMD2<Float> {
        let basis = cameraBasis()
        let aspect = viewportSize.x / viewportSize.y
        let ndcX = point.x / viewportSize.x * 2 - 1
        let ndcY = 1 - point.y / viewportSize.y * 2
        let origin = cameraPosition(focusing: framing.focus)
            + basis.right * (ndcX * framing.scale * aspect)
            + basis.up * (ndcY * framing.scale)
        // The fixed 45° pitch keeps `forward.y` strictly negative, so the ray always hits Y = 0.
        let t = -origin.y / basis.forward.y
        return legacyPoint(forWorldPosition: origin + basis.forward * t)
    }

    /// Inverse of `worldPosition(forLegacyPoint:)`: collapses a floor-plane world position back
    /// to its legacy pixel coordinate, keeping the pixel↔world axis mapping inside the rig.
    static func legacyPoint(forWorldPosition position: SIMD3<Float>) -> SIMD2<Float> {
        SIMD2<Float>(position.x, position.z) / worldUnitsPerPixel
    }

    /// Projects a legacy pixel coordinate to its top-left-origin viewport point at `framing` —
    /// the forward direction of `legacyPoint(forViewport:viewportSize:framing:)`. Public for
    /// the editor's direct-manipulation layer, which projects selection bounds back to screen
    /// space to hit-test resize/facing handles and marquee intersections.
    static func viewportPoint(
        forLegacyPoint point: SIMD2<Float>,
        viewportSize: SIMD2<Float>,
        framing: EditorFraming
    ) -> SIMD2<Float> {
        let basis = cameraBasis()
        let aspect = viewportSize.x / viewportSize.y
        // The framing focus sits on the camera axis, so plane offsets are relative to it.
        // `scale` is the vertical half-height (see `legacyPoint(forViewport:)`).
        let relative = worldPosition(forLegacyPoint: point) - framing.focus
        let ndcX = dot(relative, basis.right) / (framing.scale * aspect)
        let ndcY = dot(relative, basis.up) / framing.scale
        return SIMD2<Float>(
            (ndcX + 1) / 2 * viewportSize.x,
            (1 - ndcY) / 2 * viewportSize.y
        )
    }

    /// Legacy-pixel bounding rect of the sector floor plus every authored object footprint,
    /// widened to `Float` before the extent math so an `Int16` overflow coordinate cannot trap.
    /// Public alongside `editorFraming(fitting:viewportSize:)` so the editor can clamp its
    /// pan focus to the same extent the whole-sector fit frames.
    static func fitPixelBounds(of body: SectorBody) -> (min: SIMD2<Float>, max: SIMD2<Float>) {
        var minBound = SIMD2<Float>(0, 0)
        var maxBound = SIMD2<Float>(Float(body.pixelWidth), Float(body.pixelHeight))
        for object in body.objects {
            let origin = SIMD2<Float>(Float(object.x), Float(object.y))
            let extent = origin + SIMD2<Float>(Float(object.sourceWidth), Float(object.sourceHeight))
            minBound = min(minBound, origin)
            maxBound = max(maxBound, extent)
        }
        return (minBound, maxBound)
    }
}
