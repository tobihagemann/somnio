import Foundation
import SomnioCore

/// Pure yaw interpolation for the discrete wire facing: maps a `Direction` to a target yaw
/// about +Y and slews toward it along the shortest arc at a fixed fast turn rate, applied
/// identically to local and remote facing changes so both feel the same. Decoupled from the
/// per-kind position-tween durations. Kept free of RealityKit like `OrthographicCameraRig`.
public enum YawSlew {
    /// Fixed angular rate: a quarter turn (90°) completes in 0.175 s regardless of how the
    /// facing change arrived.
    public static let turnRate: Float = (.pi / 2) / 0.175

    /// Target yaw for a facing, in radians about +Y. Zero faces south (+Z, toward the 3/4
    /// camera); positive rotates toward east (+X). Assumes the converted models' rest pose
    /// faces +Z — if the pack's export convention ever flips, this mapping is the one place
    /// to offset.
    public static func yaw(for direction: Direction) -> Float {
        switch direction {
        case .south: return 0
        case .east: return .pi / 2
        case .north: return .pi
        case .west: return -.pi / 2
        }
    }

    /// One integration step toward `target` along the shortest arc, clamped so the result
    /// never overshoots. The IEEE remainder keeps the delta in [-π, π], so the S↔N 180° case
    /// resolves to one consistent turn direction instead of spinning. Returns a yaw wrapped
    /// into [-π, π].
    public static func step(from current: Float, toward target: Float, deltaTime: TimeInterval) -> Float {
        let delta = (target - current).remainder(dividingBy: 2 * .pi)
        let maxStep = turnRate * Float(deltaTime)
        guard abs(delta) > maxStep else { return target }
        return (current + copysign(maxStep, delta)).remainder(dividingBy: 2 * .pi)
    }
}
