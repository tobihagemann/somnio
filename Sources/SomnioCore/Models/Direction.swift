import Foundation

/// Discrete cardinal direction — the vocabulary of the editor's facing picker. Runtime facing
/// is the continuous `Heading`; it bridges here via `Heading(cardinal:)`/`nearestCardinal`.
public enum Direction: Int16, Sendable, Equatable, Hashable, CaseIterable {
    case north = 0
    case east = 1
    case south = 2
    case west = 3
}
