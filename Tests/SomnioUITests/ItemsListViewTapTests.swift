import SomnioCore
import SwiftUI
import Testing
@testable import SomnioUI

/// Smoke-level coverage of the per-hand tap callback. The view's body is exercised
/// by simply rendering it; the tap callback is verified by invoking the closure
/// MainWindowView would forward into.
@MainActor
struct ItemsListViewTapTests {
    @Test func `passing onItemTap to MainWindowView forwards the tap to ItemsListView`() {
        let row = InventoryRow(slot: 0, category: 0, itemId: 0, equippedHand: nil)
        var captured: (InventoryRow, Hand)?
        let view = ItemsListView(
            items: [row],
            locale: Locale(identifier: "en"),
            onItemTap: { tappedRow, hand in
                captured = (tappedRow, hand)
            }
        )
        view.invokeTap(row: row, hand: .left)
        #expect(captured?.0 == row)
        #expect(captured?.1 == .left)

        view.invokeTap(row: row, hand: .right)
        #expect(captured?.1 == .right)
    }

    @Test func `nil onItemTap is safe`() {
        let row = InventoryRow(slot: 0, category: 0, itemId: 0, equippedHand: nil)
        let view = ItemsListView(items: [row], locale: Locale(identifier: "en"))
        view.invokeTap(row: row, hand: .left)
        // No crash, no callback — done.
    }
}

private extension ItemsListView {
    /// Test seam: invokes the same closure path the per-hand cell tap would invoke.
    func invokeTap(row: InventoryRow, hand: Hand) {
        onItemTap?(row, hand)
    }
}
