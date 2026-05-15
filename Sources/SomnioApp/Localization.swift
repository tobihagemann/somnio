import Foundation

// swiftlint:disable type_name

/// Localized-string access for the player client. `Bundle.module` resolves to the
/// `SomnioApp` resource bundle and pins the catalog at `Resources/Localizable.xcstrings`.
/// Production callers omit `locale` so the resolved string follows the user's current
/// locale; tests pass an explicit `Locale` so assertions are stable across CI machines.
enum L {
    static func string(_ key: String.LocalizationValue, locale: Locale? = nil) -> String {
        if let locale {
            return String(localized: key, bundle: .module, locale: locale)
        }
        return String(localized: key, bundle: .module)
    }

    /// Returns a `LocalizedStringResource` pinned to the SomnioApp catalog so SwiftUI
    /// surfaces that accept `LocalizedStringResource` (e.g. `Button(_:)`, `.help(...)`)
    /// bypass the `.main` bundle default that would silently miss the SwiftPM `.process`
    /// resource shipment.
    static func resource(_ key: String.LocalizationValue) -> LocalizedStringResource {
        LocalizedStringResource(key, bundle: .atURL(Bundle.module.bundleURL))
    }
}

// swiftlint:enable type_name
