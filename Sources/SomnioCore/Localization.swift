import Foundation

/// Cross-platform catalog lookup for SomnioCore's library-internal localized strings.
///
/// `String(localized:)` and `String.LocalizationValue` are absent from Linux Foundation, so
/// the lookup is gated behind `canImport(Darwin)`. These labels render only in the macOS
/// client/editor UI — the Linux server never shows them — so returning the English source
/// string (which doubles as the catalog key) is the correct Linux fallback.
enum CoreCatalog {
    static func localized(_ key: String, locale: Locale? = nil) -> String {
        #if canImport(Darwin)
            let value = String.LocalizationValue(key)
            if let locale {
                return String(localized: value, bundle: .module, locale: locale)
            }
            return String(localized: value, bundle: .module)
        #else
            return key
        #endif
    }
}
