import Foundation

/// Continuous facing heading in `Float` degrees, normalized into `[0, 360)`. Zero faces south
/// (+Z, toward the 3/4 camera) and increasing degrees rotate toward east (+X) — the same
/// convention as `YawSlew`'s radians, so the RealityKit seam is a pure `degrees → radians`
/// conversion. `Heading` is the facing type at the runtime seams (wire, DB, sector-file
/// NPC, render DTO); `Direction` is the editor's discrete N/E/S/W facing-picker vocabulary
/// (spawn/portal facing), bridged to and from this continuous heading via
/// `init(cardinal:)` / `nearestCardinal`.
public struct Heading: Sendable, Equatable, Hashable {
    public var degrees: Float

    /// Creates a heading from any degree value, wrapping it into `[0, 360)`. There is no
    /// invalid raw value to reject (unlike `Direction(rawValue:)`), so normalization here is
    /// the validation: out-of-range and negative inputs fold in, and a non-finite input
    /// collapses to `0` rather than propagating NaN into the transform math.
    public init(degrees: Float) {
        guard degrees.isFinite else {
            self.degrees = 0
            return
        }
        var wrapped = degrees.truncatingRemainder(dividingBy: 360)
        if wrapped < 0 { wrapped += 360 }
        // A tiny negative can round `wrapped + 360` back up to exactly 360; keep the
        // half-open upper bound.
        if wrapped == 360 { wrapped = 0 }
        self.degrees = wrapped
    }

    /// The cardinal bridge: south 0°, east 90°, north 180°, west 270°.
    public init(cardinal: Direction) {
        switch cardinal {
        case .south: self.init(degrees: 0)
        case .east: self.init(degrees: 90)
        case .north: self.init(degrees: 180)
        case .west: self.init(degrees: 270)
        }
    }

    /// The heading of a floor-axis vector (`dx` grows east, `dy` grows south — legacy pixel
    /// axes): the single home of the vector→heading conversion, so the axis convention and
    /// the Float rounding live in one place.
    public init(dx: Float, dy: Float) {
        self.init(degrees: atan2(dx, dy) * 180 / .pi)
    }

    /// The RealityKit yaw about +Y for this heading.
    public var radians: Float {
        degrees * .pi / 180
    }

    /// Quantizes a continuous heading back to a discrete `Direction` — the reverse of the
    /// cardinal bridge. Half-open buckets centered on each cardinal, every boundary owned
    /// deterministically by the higher bucket (45° → east, 135° → north, 225° → west,
    /// 315° → south) so exact diagonals never straddle.
    public var nearestCardinal: Direction {
        switch degrees {
        case 45 ..< 135: .east
        case 135 ..< 225: .north
        case 225 ..< 315: .west
        default: .south
        }
    }

    /// Signed shortest-arc delta from this heading to `other`, in degrees folded into
    /// `[-180, 180]` — so a comparison across the 0°/360° seam (359° vs 1°) measures the real
    /// 2° turn rather than a naive 358° difference.
    public func angularDistance(to other: Heading) -> Float {
        (other.degrees - degrees + 540).truncatingRemainder(dividingBy: 360) - 180
    }
}

/// Serializes as a bare JSON number (the degrees) rather than a keyed container, so the
/// sector-file NPC facing reads as `"direction" : 270`. Decoding routes through
/// `init(degrees:)` so persisted out-of-range values normalize instead of surviving raw.
extension Heading: Codable {
    public init(from decoder: Decoder) throws {
        try self.init(degrees: decoder.singleValueContainer().decode(Float.self))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(degrees)
    }
}
