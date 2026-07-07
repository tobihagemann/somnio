import SomnioCore
import SwiftUI

/// Inventory list with a name column, a display-only equip marker, and an "Items: N" footer.
/// Mirrors the legacy `InventarBox`: double-clicking a row toggles that item's equip state and
/// forwards the row to `onItemActivate`; the `[L]` / `[R]` marker only reflects the hand the
/// server reports — the player never picks a hand (each item equips to its own fixed hand).
public struct ItemsListView: View {
    public let items: [InventoryRow]
    public let locale: Locale?
    public let onItemActivate: ((InventoryRow) -> Void)?

    public init(
        items: [InventoryRow],
        locale: Locale? = nil,
        onItemActivate: ((InventoryRow) -> Void)? = nil
    ) {
        self.items = items
        self.locale = locale
        self.onItemActivate = onItemActivate
    }

    public var body: some View {
        VStack(spacing: 4) {
            List(Array(items.enumerated()), id: \.offset) { _, row in
                HStack(spacing: 4) {
                    Text(verbatim: ItemCatalog.displayName(category: row.category, itemId: row.itemId, locale: locale))
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(verbatim: marker(for: row))
                        .frame(width: 24, alignment: .trailing)
                }
                .foregroundStyle(.white)
                .listRowSeparator(.hidden)
                .contentShape(Rectangle())
                // Double-click the whole row, matching the legacy `InventarBox` DoubleClick handler.
                // A double-click (not a single tap) is also required because the macOS `List`
                // swallows single taps on row content via its table-view row handling.
                .onTapGesture(count: 2) { onItemActivate?(row) }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            Text(verbatim: String(format: L.string("Items: %@", locale: locale), String(items.count)))
                .foregroundStyle(FantasyPalette.secondaryText)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// `[L]` / `[R]` are layout-only status markers, not translatable text — the legacy original
    /// hardcodes them too, so they are deliberately not catalog entries (localization sweep
    /// whitelists them).
    private func marker(for row: InventoryRow) -> String {
        switch row.equippedHand {
        case .left: return "[L]"
        case .right: return "[R]"
        case nil: return ""
        }
    }
}
