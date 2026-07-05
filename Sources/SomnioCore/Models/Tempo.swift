import Foundation

public enum Tempo: Int16, Sendable, Equatable, Hashable, CaseIterable {
    case walk = 1
    case `default` = 2
    case run = 4
}

public extension Tempo {
    /// Movement speed in pixels per second, scaled by elapsed wall-clock time in the client
    /// predictor (the original's `j = tempo * 60 * frameintervall`), keeping speed
    /// frame-rate-independent. Deliberately diverges from the legacy presets: sneak and run
    /// read believably against the KayKit clips rather than as arcade extremes.
    var pixelsPerSecond: Double {
        switch self {
        case .walk: 50
        case .default: 100
        case .run: 150
        }
    }
}
