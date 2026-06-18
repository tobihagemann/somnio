import Foundation

/// Ordered representation of category-specific extras (e.g. `{"gold": N}` for the purse).
/// The ordered-array form replaces a raw `[String: Int16]` so binary serialization is
/// deterministic; runtime code that needs map-style lookup constructs a transient
/// `Dictionary(uniqueKeysWithValues: row.extras.map { ($0.key, $0.value) })`.
public struct InventoryExtra: Codable, Sendable, Equatable, Hashable {
    /// Extra key carrying the purse's coin balance. The wire key is a property name, so the literal
    /// is shared here rather than written at each producer/consumer (a typo would silently read 0).
    public static let goldKey = "gold"

    public var key: String
    public var value: Int16

    public init(key: String, value: Int16) {
        self.key = key
        self.value = value
    }
}

public struct InventoryRow: Sendable, Equatable, Hashable {
    public var slot: Int16
    public var category: Int16
    public var itemId: Int16
    public var extras: [InventoryExtra]
    public var equippedHand: Hand?

    public init(
        slot: Int16,
        category: Int16,
        itemId: Int16,
        extras: [InventoryExtra] = [],
        equippedHand: Hand? = nil
    ) {
        self.slot = slot
        self.category = category
        self.itemId = itemId
        self.extras = extras
        self.equippedHand = equippedHand
    }

    /// Coin balance carried by the `gold` extra (the purse), or 0 when absent.
    public var goldBalance: Int16 {
        extras.first { $0.key == InventoryExtra.goldKey }?.value ?? 0
    }
}
