import Foundation

/// The structural defects `assertCatalog(in:expectedKeys:)` rejects. Thrown (rather than
/// asserted with `Testing`) so the helper stays Foundation-only like the rest of this
/// module; an uncaught throw fails the calling `@Test`, and `description` names the key.
public enum CatalogValidationError: Error, CustomStringConvertible, Equatable {
    case missingKey(String)
    case missingLocaleValue(key: String, locale: String)
    case placeholderMismatch(key: String, english: String, german: String)
    case unicodeEllipsisInKey(String)
    case unicodeEllipsisInValue(key: String, locale: String, value: String)

    public var description: String {
        switch self {
        case let .missingKey(key):
            "missing catalog entry for \(key)"
        case let .missingLocaleValue(key, locale):
            "missing \(locale) value for \(key)"
        case let .placeholderMismatch(key, english, german):
            "placeholder signature mismatch for \(key): en=\(english) de=\(german)"
        case let .unicodeEllipsisInKey(key):
            "Unicode ellipsis in key \(key)"
        case let .unicodeEllipsisInValue(key, locale, value):
            "Unicode ellipsis in \(key) [\(locale)]: \(value)"
        }
    }
}

/// Validates a target's bilingual `Localizable.xcstrings`: every `expectedKey` ships a
/// non-empty English and German value, the two locales carry the same placeholder
/// signature, and no key or value uses the Unicode ellipsis. Shared by every per-target
/// catalog test so a new catalog ships a one-line check. `allowedUnicodeEllipsisKeys`
/// carries the documented carve-outs (the editor's `Loading…` window title is the
/// codebase's only one).
public func assertCatalog(
    in bundle: Bundle,
    expectedKeys: [String],
    allowedUnicodeEllipsisKeys: Set<String> = []
) throws {
    let catalog = try CatalogParser.parse(from: bundle)
    try assertCatalog(catalog, expectedKeys: expectedKeys, allowedUnicodeEllipsisKeys: allowedUnicodeEllipsisKeys)
}

/// Validation core over an already-parsed `[key: [locale: value]]` catalog. Exposed so the
/// rules (including the failure paths) can be exercised directly with synthetic catalogs;
/// the bundle overload is the production entry point.
public func assertCatalog(
    _ catalog: [String: [String: String]],
    expectedKeys: [String],
    allowedUnicodeEllipsisKeys: Set<String> = []
) throws {
    for key in expectedKeys {
        guard let entry = catalog[key] else { throw CatalogValidationError.missingKey(key) }
        guard let english = entry["en"], !english.isEmpty else {
            throw CatalogValidationError.missingLocaleValue(key: key, locale: "en")
        }
        guard let german = entry["de"], !german.isEmpty else {
            throw CatalogValidationError.missingLocaleValue(key: key, locale: "de")
        }
        guard PlaceholderSignature.parse(english) == PlaceholderSignature.parse(german) else {
            throw CatalogValidationError.placeholderMismatch(key: key, english: english, german: german)
        }
    }
    for (key, entry) in catalog where !allowedUnicodeEllipsisKeys.contains(key) {
        if key.contains("\u{2026}") {
            throw CatalogValidationError.unicodeEllipsisInKey(key)
        }
        for (locale, value) in entry where value.contains("\u{2026}") {
            throw CatalogValidationError.unicodeEllipsisInValue(key: key, locale: locale, value: value)
        }
    }
}
