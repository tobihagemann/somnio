import Foundation
import SomnioCatalogTestSupport
import Testing
@testable import SomnioUI

struct LocalizableCatalogTests {
    private static let expectedKeys: [String] = [
        "%1$@ says, \"%2$@\"",
        "%1$@ asks, \"%2$@\"",
        "%1$@ exclaims, \"%2$@\"",
        "Broadcast message: %@",
        "Welcome to Somnio!",
        "The connection was lost.",
        "The server is currently not reachable. Try again later.",
        "Bad credentials.",
        "Already logged in.",
        "Error %@ occurred.",
        "%@ entered the game.",
        "%@ left the game.",
        "HP",
        "Balance",
        "Mana",
        "Players: %@",
        "Items: %@"
    ]

    @Test func `every key ships English and German values`() throws {
        let catalog = try CatalogParser.parse(from: Bundle.module)
        for key in LocalizableCatalogTests.expectedKeys {
            let entry = try #require(catalog[key], "missing catalog entry for \(key)")
            #expect(entry["en"]?.isEmpty == false, "missing English value for \(key)")
            #expect(entry["de"]?.isEmpty == false, "missing German value for \(key)")
        }
    }

    @Test func `placeholder signature matches across English and German for every key`() throws {
        let catalog = try CatalogParser.parse(from: Bundle.module)
        for key in LocalizableCatalogTests.expectedKeys {
            let entry = try #require(catalog[key])
            let englishValue = try #require(entry["en"])
            let germanValue = try #require(entry["de"])
            #expect(
                PlaceholderSignature.parse(englishValue) == PlaceholderSignature.parse(germanValue),
                "placeholder signature mismatch for \(key): en=\(englishValue) de=\(germanValue)"
            )
        }
    }

    @Test func `no Unicode ellipsis appears in any catalog value`() throws {
        let catalog = try CatalogParser.parse(from: Bundle.module)
        for (key, entry) in catalog {
            for (locale, value) in entry {
                #expect(!value.contains("\u{2026}"), "Unicode ellipsis in \(key) [\(locale)]: \(value)")
            }
        }
    }

    @Test func `runtime resolution returns the source string for HUD tooltip keys`() {
        #expect(L.string("HP") == "HP")
        #expect(L.string("Balance") == "Balance")
        #expect(L.string("Mana") == "Mana")
    }

    @Test(arguments: [
        ("Players: %@", PlaceholderSignature(positionalIndices: [], bareCount: 1)),
        ("%1$@ says, \"%2$@\"", PlaceholderSignature(positionalIndices: [1, 2], bareCount: 0)),
        ("%@ greeted %1$@", PlaceholderSignature(positionalIndices: [1], bareCount: 1)),
        ("%99 of users", PlaceholderSignature(positionalIndices: [], bareCount: 0)),
        ("Test %%@ value", PlaceholderSignature(positionalIndices: [], bareCount: 0)),
        ("Literal %% sign", PlaceholderSignature(positionalIndices: [], bareCount: 0)),
        ("%%%@", PlaceholderSignature(positionalIndices: [], bareCount: 1)),
        ("%%%1$@", PlaceholderSignature(positionalIndices: [1], bareCount: 0)),
        ("%@%1$@", PlaceholderSignature(positionalIndices: [1], bareCount: 1)),
        ("%%d works", PlaceholderSignature(positionalIndices: [], bareCount: 0)),
        ("trailing %%", PlaceholderSignature(positionalIndices: [], bareCount: 0)),
        ("trailing %", PlaceholderSignature(positionalIndices: [], bareCount: 0))
    ])
    func `placeholder parser`(input: String, expected: PlaceholderSignature) {
        #expect(PlaceholderSignature.parse(input) == expected)
    }
}
