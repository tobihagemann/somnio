import SomnioCore
import SwiftUI

/// `[L]` / `[R]` glyphs are layout-only markers, not translatable text — the legacy
/// original hardcodes them too. They are deliberately not catalog entries; the
/// localization-compliance sweep whitelists them.
private extension Hand {
    var bracketGlyph: String {
        switch self {
        case .left: return "[L]"
        case .right: return "[R]"
        }
    }
}

/// Two-column inventory list with a name column and a per-hand `[L]` / `[R]` flag pair,
/// plus an "Items: N" footer. The legacy `InventarBox` flag column maps to two ~20 px
/// cells: the left cell shows `[L]` when equipped to the left hand, the right cell shows
/// `[R]` when equipped to the right hand. Tapping either cell forwards `(row, hand)` to
/// `onItemTap`; the name column is non-interactive.
public struct ItemsListView: View {
    public let items: [InventoryRow]
    public let locale: Locale?
    public let onItemTap: ((InventoryRow, Hand) -> Void)?

    public init(
        items: [InventoryRow],
        locale: Locale? = nil,
        onItemTap: ((InventoryRow, Hand) -> Void)? = nil
    ) {
        self.items = items
        self.locale = locale
        self.onItemTap = onItemTap
    }

    public var body: some View {
        VStack(spacing: 0) {
            List(Array(items.enumerated()), id: \.offset) { _, row in
                HStack(spacing: 0) {
                    Text(verbatim: ItemCatalog.displayName(category: row.category, itemId: row.itemId, locale: locale))
                        .frame(width: 110, alignment: .leading)
                    handCell(row: row, hand: .left)
                    handCell(row: row, hand: .right)
                }
            }
            .listStyle(.plain)
            .frame(width: 150, height: 100)
            Text(verbatim: String(format: L.string("Items: %@", locale: locale), String(items.count)))
                .frame(width: 150, height: 14, alignment: .leading)
        }
    }

    @ViewBuilder
    private func handCell(row: InventoryRow, hand: Hand) -> some View {
        let glyph = row.equippedHand == hand ? hand.bracketGlyph : ""
        Text(verbatim: glyph)
            .frame(width: 20, height: 20, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture { onItemTap?(row, hand) }
    }
}
