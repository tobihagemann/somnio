import Foundation

public enum CatalogParserError: Error, Sendable, Equatable {
    case missing
    case malformedJSON
}

/// Reads a SwiftPM `.xcstrings` resource straight out of the resource bundle's JSON
/// and returns it as `[key: [locale: value]]`. Bypasses Foundation's localization
/// runtime because SwiftPM does not compile `.xcstrings` into per-locale `.strings`
/// artifacts — tests pin the German catalog at the JSON level so positional
/// placeholder mismatches do not silently fall back to English.
public enum CatalogParser {
    /// Returns the bilingual catalog shipped at `bundle/Localizable.xcstrings`.
    /// Throws `.missing` when the resource is absent from the bundle, and
    /// `.malformedJSON` when the JSON does not match the expected schema.
    public static func parse(from bundle: Bundle) throws -> [String: [String: String]] {
        guard let url = bundle.url(forResource: "Localizable", withExtension: "xcstrings") else {
            throw CatalogParserError.missing
        }
        let data = try Data(contentsOf: url)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let strings = json["strings"] as? [String: Any]
        else {
            throw CatalogParserError.malformedJSON
        }
        var output: [String: [String: String]] = [:]
        for (key, entryAny) in strings {
            guard let entry = entryAny as? [String: Any],
                  let localizations = entry["localizations"] as? [String: Any]
            else { continue }
            var bucket: [String: String] = [:]
            for (locale, value) in localizations {
                guard let valueDict = value as? [String: Any],
                      let stringUnit = valueDict["stringUnit"] as? [String: Any],
                      let text = stringUnit["value"] as? String
                else { continue }
                bucket[locale] = text
            }
            output[key] = bucket
        }
        return output
    }
}
