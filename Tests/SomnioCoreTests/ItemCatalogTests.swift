import Foundation
import SomnioCatalogTestSupport
import Testing
@testable import SomnioCore

struct ItemCatalogTests {
    private let en = Locale(identifier: "en_US")

    @Test func `purse resolves to the English label`() {
        #expect(ItemCatalog.displayName(category: 0, itemId: 0, locale: en) == "Purse")
    }

    @Test func `cudgel resolves to the English label`() {
        #expect(ItemCatalog.displayName(category: 1, itemId: 0, locale: en) == "Cudgel")
    }

    @Test func `unknown category and item id returns empty string`() {
        #expect(ItemCatalog.displayName(category: 99, itemId: 99, locale: en) == "")
    }

    @Test func `unknown item id within known category returns empty string`() {
        #expect(ItemCatalog.displayName(category: 0, itemId: 1, locale: en) == "")
    }

    @Test func `purse and cudgel ship English and German values in the catalog`() throws {
        let catalog = try CatalogParser.parse(from: Bundle.somnioCoreModule)
        for key in ["Purse", "Cudgel"] {
            let entry = try #require(catalog[key], "missing catalog entry for \(key)")
            #expect(entry["en"]?.isEmpty == false, "missing English value for \(key)")
            #expect(entry["de"]?.isEmpty == false, "missing German value for \(key)")
        }
    }

    @Test func `german inventory labels match the legacy seed`() throws {
        let catalog = try CatalogParser.parse(from: Bundle.somnioCoreModule)
        #expect(catalog["Purse"]?["de"] == "Geldbeutel")
        #expect(catalog["Cudgel"]?["de"] == "Knüppel")
    }
}
