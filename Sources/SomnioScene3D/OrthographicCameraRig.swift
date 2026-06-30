import Foundation
import simd

/// Pure placement math for the fixed 3/4 (Diablo-style) orthographic camera. Kept free of
/// RealityKit so the rig is unit-testable without a live renderer (RealityKit visual output is
/// verified by smoke-testing, not headless rendering). `WorldScene3D` applies these results to
/// its camera entity; the numeric values are prototype-time tunables, not fixed contracts.
public enum OrthographicCameraRig {
    /// Overhead tilt and horizontal swing of the locked viewpoint, in degrees.
    public static let pitchDegrees: Float = 45
    public static let yawDegrees: Float = 35
    /// Distance the camera sits back from its focus point along the fixed view direction. Pure
    /// translation under an orthographic projection, so it only has to clear the near plane and
    /// keep the floor inside `[nearClip, farClip]`.
    public static let cameraDistance: Float = 50
    /// Orthographic `scale` is the vertical world extent the viewport spans; smaller is more
    /// zoomed in. `defaultScale` is the resting zoom; `clampedScale` bounds interactive zoom.
    public static let defaultScale: Float = 15
    public static let minScale: Float = 6
    public static let maxScale: Float = 24
    public static let nearClip: Float = 0.05
    public static let farClip: Float = 500
    /// World units per legacy pixel. The tile grid stays authoritative in pixels; this scales it
    /// into RealityKit's metric space for floor sizing and entity placement.
    public static let worldUnitsPerPixel: Float = 0.02

    public static func clampedScale(_ scale: Float) -> Float {
        min(max(scale, minScale), maxScale)
    }

    /// Maps a legacy top-left pixel coordinate onto the flat floor (Y = 0): X runs east, the
    /// legacy Y-down axis runs along +Z (into the scene under the 3/4 camera).
    public static func worldPosition(forLegacyX x: Int16, y: Int16) -> SIMD3<Float> {
        SIMD3<Float>(Float(x) * worldUnitsPerPixel, 0, Float(y) * worldUnitsPerPixel)
    }

    /// Unit direction from the focus point toward the camera, derived from the fixed pitch + yaw.
    public static func offsetDirection() -> SIMD3<Float> {
        let pitch = pitchDegrees * .pi / 180
        let yaw = yawDegrees * .pi / 180
        return SIMD3<Float>(
            cos(pitch) * sin(yaw),
            sin(pitch),
            cos(pitch) * cos(yaw)
        )
    }

    public static func cameraPosition(focusing focus: SIMD3<Float>) -> SIMD3<Float> {
        focus + offsetDirection() * cameraDistance
    }

    public static func cameraOrientation(focusing focus: SIMD3<Float>) -> simd_quatf {
        lookRotation(from: cameraPosition(focusing: focus), to: focus)
    }

    /// Right-handed look-at rotation orienting a RealityKit camera (which looks down its local
    /// -Z axis) so its forward points from `eye` to `target`.
    static func lookRotation(from eye: SIMD3<Float>, to target: SIMD3<Float>, up: SIMD3<Float> = [0, 1, 0]) -> simd_quatf {
        let forward = normalize(target - eye)
        let zAxis = -forward
        let xAxis = normalize(cross(up, zAxis))
        let yAxis = cross(zAxis, xAxis)
        return simd_quatf(float3x3(xAxis, yAxis, zAxis))
    }
}
