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
        "Your password could not be saved.",
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
}
