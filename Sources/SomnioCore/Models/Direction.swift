import Foundation

/// Discrete sprite-facing direction. Mirrors the original's 4 cardinal values used by the
/// `richtung` field on the wire. Encoded as `Int16` rawValue.
public enum Direction: Int16, Sendable, Equatable, Hashable, CaseIterable {
    case north = 0
    case east = 1
    case south = 2
    case west = 3
}
