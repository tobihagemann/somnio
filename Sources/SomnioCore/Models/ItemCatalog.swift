import Foundation
import Logging

/// Display-name lookup for inventory rows by `(category, itemId)` pair. The MVP table
/// covers the two starter items shipped by `StarterInventory`. Unknown pairs return
/// the empty string and log a warning so missing wire entries surface in operator logs.
public enum ItemCatalog {
    private static let logger = Logger(label: "de.tobiha.somnio.core.itemcatalog")

    public static func displayName(category: Int16, itemId: Int16, locale: Locale? = nil) -> String {
        switch (category, itemId) {
        case (0, 0):
            return localized("Purse", locale: locale)
        case (1, 0):
            return localized("Cudgel", locale: locale)
        default:
            logger.warning("Unknown inventory item: category=\(category) itemId=\(itemId)")
            return ""
        }
    }

    private static func localized(_ key: String.LocalizationValue, locale: Locale?) -> String {
        if let locale {
            return String(localized: key, bundle: .module, locale: locale)
        }
        return String(localized: key, bundle: .module)
    }
}
