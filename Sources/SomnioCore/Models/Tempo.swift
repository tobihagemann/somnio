import Foundation

public enum Tempo: Int16, Sendable, Equatable, Hashable, CaseIterable {
    case walk = 1
    case `default` = 2
    case run = 4
}

public extension Tempo {
    /// Movement speed in pixels per second: walk 60, default 120, run 240. The original scales
    /// the per-frame step by elapsed wall-clock time (`j = tempo * 60 * frameintervall`), so the
    /// client predictor multiplies this by the tick's elapsed seconds rather than the raw
    /// `rawValue`, keeping speed frame-rate-independent.
    var pixelsPerSecond: Double {
        switch self {
        case .walk: 60
        case .default: 120
        case .run: 240
        }
    }
}
