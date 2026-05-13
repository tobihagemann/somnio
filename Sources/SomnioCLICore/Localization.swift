import Foundation

/// Localized-string access for the admin CLI. `Bundle.module` resolves to the
/// `SomnioCLICore` resource bundle and pins the catalog at
/// `Resources/Localizable.xcstrings`. Production callers omit `locale` so the resolved
/// string follows the user's current locale; tests pass an explicit `Locale` so
/// assertions are stable across CI machines.
enum L {
    static func string(_ key: String.LocalizationValue) -> String {
        String(localized: key, bundle: .module)
    }

    static func string(_ key: String.LocalizationValue, locale: Locale?) -> String {
        if let locale {
            return String(localized: key, bundle: .module, locale: locale)
        }
        return String(localized: key, bundle: .module)
    }
}
