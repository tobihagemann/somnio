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

    @Test func `catalog ships bilingual values with matching placeholders and no Unicode ellipsis`() throws {
        try assertCatalog(in: Bundle.somnioUIModule, expectedKeys: LocalizableCatalogTests.expectedKeys)
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
