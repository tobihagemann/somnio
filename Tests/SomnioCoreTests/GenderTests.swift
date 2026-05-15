import Foundation
import SomnioCatalogTestSupport
import Testing
@testable import SomnioCore

struct GenderTests {
    @Test func `male and female ship English and German values in the catalog`() throws {
        let catalog = try CatalogParser.parse(from: Bundle.somnioCoreModule)
        for key in ["Male", "Female"] {
            let entry = try #require(catalog[key], "missing catalog entry for \(key)")
            #expect(entry["en"]?.isEmpty == false, "missing English value for \(key)")
            #expect(entry["de"]?.isEmpty == false, "missing German value for \(key)")
        }
    }

    @Test func `german gender labels match the legacy registration form`() throws {
        let catalog = try CatalogParser.parse(from: Bundle.somnioCoreModule)
        #expect(catalog["Male"]?["de"] == "Männlich")
        #expect(catalog["Female"]?["de"] == "Weiblich")
    }

    @Test func `displayName resolves to the source string in English`() {
        // The Bundle.module-resolved string in tests defaults to the source language;
        // mirrors the existing CharacterClass / ItemCatalog assertions.
        #expect(Gender.male.displayName == "Male")
        #expect(Gender.female.displayName == "Female")
    }
}
