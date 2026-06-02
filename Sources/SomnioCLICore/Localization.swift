import Foundation

/// Localized-string access for the admin CLI. `Bundle.module` resolves to the
/// `SomnioCLICore` resource bundle and pins the catalog at
/// `Resources/Localizable.xcstrings`. Production callers omit `locale` so the resolved
/// string follows the user's current locale; tests pass an explicit `Locale` so
/// assertions are stable across CI machines.
///
/// Gated behind `canImport(Darwin)` because Linux Foundation lacks `String(localized:)`; the
/// CLI ships for both platforms, and on Linux the English key is returned verbatim.
enum L {
    static func string(_ key: String) -> String {
        string(key, locale: nil)
    }

    static func string(_ key: String, locale: Locale?) -> String {
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
