import Foundation

/// Discrete cardinal direction — the vocabulary the browser editor's facing picker mirrors in
/// TypeScript. No runtime Swift path constructs it (facing is the continuous `Heading`); it is
/// retained as the discrete-facing reference and bridges via `Heading(cardinal:)`/`nearestCardinal`.
public enum Direction: Int16, Sendable, Equatable, Hashable, CaseIterable {
    case north = 0
    case east = 1
    case south = 2
    case west = 3
}
