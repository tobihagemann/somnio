import Foundation

/// Pure yaw interpolation for the wire heading: slews toward the target yaw (the heading's
/// radians about +Y — zero faces south/+Z, positive rotates toward east/+X, assuming the
/// converted models' rest pose faces +Z) along the shortest arc at a fixed fast turn rate,
/// applied identically to local and remote facing changes so both feel the same. Decoupled
/// from the per-kind position-tween durations. Kept free of RealityKit like
/// `OrthographicCameraRig`.
public enum YawSlew {
    /// Fixed angular rate: a quarter turn (90°) completes in 0.175 s regardless of how the
    /// facing change arrived.
    public static let turnRate: Float = (.pi / 2) / 0.175

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
