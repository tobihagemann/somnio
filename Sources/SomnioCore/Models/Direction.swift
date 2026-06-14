import Foundation

/// Discrete sprite-facing direction. Mirrors the original's 4 cardinal values used by the
/// `richtung` field on the wire. Encoded as `Int16` rawValue.
public enum Direction: Int16, Sendable, Equatable, Hashable, CaseIterable {
    case north = 0
    case east = 1
    case south = 2
    case west = 3
}

public extension Direction {
    /// The original `richtung` encoding (south=0, west=1, east=2, north=3) — the order the
    /// legacy sprite sheets lay their rows (S/W/E/N) and the `NPC.direction` field stores.
    /// `Direction.rawValue` (N=0/E=1/S=2/W=3) is load-bearing across the wire, DB columns, sprite
    /// row math, the editor, and the test pins, so it is never reordered; this property is the
    /// single conversion seam consumed by sprite-row slicing and legacy NPC-facing conversion.
    var legacyRichtung: Int16 {
        switch self {
        case .south: return 0
        case .west: return 1
        case .east: return 2
        case .north: return 3
        }
    }

    /// Inverse of `legacyRichtung`: maps an original `richtung` value back to a semantic
    /// `Direction`. Returns `nil` for an out-of-range value (e.g. a corrupt NPC record).
    init?(legacyRichtung: Int16) {
        switch legacyRichtung {
        case 0: self = .south
        case 1: self = .west
        case 2: self = .east
        case 3: self = .north
        default: return nil
        }
    }
}
