import Foundation

/// Session-only scroll-wheel zoom for the player viewport. A pure value type next to the
/// rig's other camera math: it accumulates scroll deltas into a clamped magnification
/// factor, and `WorldScene3D.applyPlayerFraming(zoomFactor:)` turns that factor into the
/// camera's orthographic scale. Multiplicative steps keep the feel uniform across the
/// range (one wheel tick moves the same *fraction* at either clamp end).
public struct PlayerZoom: Equatable, Sendable {
    public static let minFactor: Double = 0.5
    public static let maxFactor: Double = 2.0
    /// Scroll-delta-to-factor gain, tuned so a full mouse-wheel flick spans a noticeable
    /// but controllable slice of the 0.5×–2× range.
    public static let scrollGain: Double = 0.015

    /// Magnification over the default framing: 1 is the stock close-up, 2 doubles it
    /// (half the world visible), 0.5 halves it.
    public private(set) var factor: Double = 1

    public init() {}

    /// Applies one scroll event's vertical delta (scroll up zooms in) and reports whether
    /// the factor actually changed — at a clamp end the caller can let the event pass.
    @discardableResult
    public mutating func applyScroll(deltaY: Double) -> Bool {
        let previous = factor
        factor = Self.clamped(factor * exp(deltaY * Self.scrollGain))
        return factor != previous
    }

    static func clamped(_ factor: Double) -> Double {
        min(max(factor, minFactor), maxFactor)
    }
}
