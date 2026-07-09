import Foundation

/// An entity's travel direction relative to where it faces — the shared vocabulary for both the
/// directional movement clip and the movement-speed penalty. Because a single value drives both
/// consumers, the clip you see and the speed you move at can never disagree.
public enum RelativeDirection: Sendable, Equatable, Hashable, CaseIterable {
    case forward
    case backward
    case strafeLeft
    case strafeRight

    /// Buckets the signed travel-vs-facing angle into the four relative directions with
    /// deterministic boundary ownership (in the spirit of `Heading.nearestCardinal`, though over
    /// absolute angular distance rather than raw degrees): within 45° of facing is forward, beyond
    /// 135° is backward, and the quarter between them is a strafe side. 45° is owned by forward and
    /// 135° by strafe.
    public init(travel: Heading, facing: Heading) {
        let signed = facing.angularDistance(to: travel)
        let magnitude = abs(signed)
        if magnitude <= 45 {
            self = .forward
        } else if magnitude > 135 {
            self = .backward
        } else {
            // Sign→side mapping pinned by smoke observation: facing the camera (south), a step to
            // screen-east is the character's own left. A mirrored mapping is a one-line swap here.
            self = signed > 0 ? .strafeLeft : .strafeRight
        }
    }

    /// Fraction of the same tempo tier's forward speed to travel at — a gameplay-feel constant,
    /// the neighbor of `Tempo.pixelsPerSecond`: strafing is slower than forward, backpedaling
    /// slower still.
    public var speedMultiplier: Double {
        switch self {
        case .forward: 1.0
        case .backward: 0.50
        case .strafeLeft, .strafeRight: 0.70
        }
    }
}
