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

/// Two-column inventory list with a name column and a `[L]` / `[R]` hand flag column,
/// plus an "Items: N" footer. Names are resolved through `ItemCatalog` so the wire
/// `(category, itemId)` pairs land in the user's locale.
public struct ItemsListView: View {
    public let items: [InventoryRow]
    public let locale: Locale?

    public init(items: [InventoryRow], locale: Locale? = nil) {
        self.items = items
        self.locale = locale
    }

    public var body: some View {
        VStack(spacing: 0) {
            List(Array(items.enumerated()), id: \.offset) { _, row in
                HStack(spacing: 4) {
                    Text(verbatim: ItemCatalog.displayName(category: row.category, itemId: row.itemId, locale: locale))
                        .frame(width: 110, alignment: .leading)
                    Text(verbatim: row.equippedHand?.bracketGlyph ?? "")
                        .frame(width: 40, alignment: .leading)
                }
            }
            .listStyle(.plain)
            .frame(width: 150, height: 100)
            Text(verbatim: String(format: L.string("Items: %@", locale: locale), String(items.count)))
                .frame(width: 150, height: 14, alignment: .leading)
        }
    }
}
