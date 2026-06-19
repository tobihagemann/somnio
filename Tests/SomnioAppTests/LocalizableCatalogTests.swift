import Foundation
import SomnioCatalogTestSupport
import Testing
@testable import SomnioApp

struct LocalizableCatalogTests {
    private static let expectedKeys: [String] = [
        // Login sheet
        "Nickname",
        "Password",
        "Remember password",
        "If you don't have an account, click here!",
        "OK",
        "Cancel",
        // Registration sheet
        "Nickname:",
        "Password:",
        "Password (*):",
        "*: repeat",
        "Character:",
        "Gender:",
        "Email:",
        // About sheet
        "Somnio",
        "Version: %@",
        "Copyright",
        "Thanks paragraph",
        // Preferences sheet
        "Log level",
        "Default",
        "Debug",
        "Verbose",
        "Server URL",
        // Menu items
        "About Somnio",
        "Check for Updates...",
        "Join Game...",
        "Leave Game",
        // Auth-result inline errors (registration only — login failures route through
        // SomnioUI's chat scrollback as typed `ChatLine.badCredentials` /
        // `.alreadyLoggedIn` cases)
        "Nickname already exists.",
        "Registration failed."
    ]

    @Test func `catalog ships bilingual values with matching placeholders and no Unicode ellipsis`() throws {
        try assertCatalog(in: Bundle.module, expectedKeys: LocalizableCatalogTests.expectedKeys)
    }

    @Test func `runtime resolution returns the source string for menu keys`() {
        #expect(L.string("OK") == "OK")
    }
}
