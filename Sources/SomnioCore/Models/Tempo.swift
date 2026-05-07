import Foundation

public enum Tempo: Int16, Sendable, Equatable, Hashable, CaseIterable {
    case walk = 1
    case `default` = 2
    case run = 4
}
