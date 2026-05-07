import Foundation

/// Canonical `Energy` value type for the project. Carries three `(current, max)` pairs
/// (HP, balance, mana) as a 12-byte LE block. SomnioCore re-exports this via a
/// `public typealias Energy = SomnioProtocol.Energy` so runtime code reads `Energy` without
/// a module qualifier.
public struct Energy: Codable, Sendable, Equatable, Hashable {
    public var hpCurrent: Int16
    public var hpMax: Int16
    public var balanceCurrent: Int16
    public var balanceMax: Int16
    public var manaCurrent: Int16
    public var manaMax: Int16

    public init(
        hpCurrent: Int16,
        hpMax: Int16,
        balanceCurrent: Int16,
        balanceMax: Int16,
        manaCurrent: Int16,
        manaMax: Int16
    ) {
        self.hpCurrent = hpCurrent
        self.hpMax = hpMax
        self.balanceCurrent = balanceCurrent
        self.balanceMax = balanceMax
        self.manaCurrent = manaCurrent
        self.manaMax = manaMax
    }

    public enum CodingKeys: String, CaseIterable, CodingKey {
        case hpCurrent; case hpMax
        case balanceCurrent; case balanceMax
        case manaCurrent; case manaMax
    }
}
