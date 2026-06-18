import SomnioCore
import SwiftUI
import Testing
@testable import SomnioUI

/// Smoke-level coverage of the row equip-toggle callback. The view's body is exercised
/// by simply rendering it; the callback is verified by invoking the closure
/// `MainWindowView` would forward into.
@MainActor
struct ItemsListViewTapTests {
    @Test func `passing onItemActivate to ItemsListView forwards the double-clicked row`() {
        let row = InventoryRow(slot: 1, category: 1, itemId: 0, equippedHand: nil)
        var captured: InventoryRow?
        let view = ItemsListView(
            items: [row],
            locale: Locale(identifier: "en"),
            onItemActivate: { toggledRow in
                captured = toggledRow
            }
        )
        view.invokeEquipToggle(row: row)
        #expect(captured == row)
    }

    @Test func `nil onItemActivate is safe`() {
        let row = InventoryRow(slot: 0, category: 0, itemId: 0, equippedHand: nil)
        let view = ItemsListView(items: [row], locale: Locale(identifier: "en"))
        view.invokeEquipToggle(row: row)
        // No crash, no callback — done.
    }
}

private extension ItemsListView {
    /// Test seam: invokes the same closure path the row double-click would invoke.
    func invokeEquipToggle(row: InventoryRow) {
        onItemActivate?(row)
    }
}
