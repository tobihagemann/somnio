import Foundation

/// Discrete sprite-facing direction — the vocabulary of the retained 2D sprite path (the
/// legacy sheets carry one row per cardinal) and the editor's facing picker. Runtime facing
/// is the continuous `Heading`; it bridges here via `Heading(cardinal:)`/`nearestCardinal`.
public enum Direction: Int16, Sendable, Equatable, Hashable, CaseIterable {
    case north = 0
    case east = 1
    case south = 2
    case west = 3
}

public extension Direction {
    /// Lowercase semantic name (`"north"/"east"/"south"/"west"`). The single seam for
    /// serializing a `Direction` by case name rather than `rawValue` — consumed by the asset
    /// manifest's `directionRows`. `rawValue` stays the in-memory encoding.
    var caseName: String {
        switch self {
        case .north: return "north"
        case .east: return "east"
        case .south: return "south"
        case .west: return "west"
        }
    }

    /// Inverse of `caseName`: maps a semantic name back to a `Direction`. Returns `nil` for an
    /// unrecognized name, so a corrupt serialized record throws at the decode seam.
    init?(caseName: String) {
        switch caseName {
        case "north": self = .north
        case "east": self = .east
        case "south": self = .south
        case "west": self = .west
        default: return nil
        }
    }
}
