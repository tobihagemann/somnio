import SomnioCore

/// Starter inventory seeded for every new account: a purse holding 100 coins and a cudgel
/// in the secondary slot. Matches the legacy server's two-row registration write.
public enum StarterInventory {
    public static let rows: [InventoryRow] = [
        InventoryRow(slot: 0, category: 0, itemId: 0, extras: [InventoryExtra(key: InventoryExtra.goldKey, value: 100)]),
        InventoryRow(slot: 1, category: 1, itemId: 0)
    ]
}
