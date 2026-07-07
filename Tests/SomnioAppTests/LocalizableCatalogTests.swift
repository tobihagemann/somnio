import Foundation
import SomnioCatalogTestSupport
import Testing
@testable import SomnioApp

struct LocalizableCatalogTests {
    private static let expectedKeys: [String] = [
        // Login overlay
        "Nickname",
        "Password",
        "Remember password",
        "If you don't have an account, click here!",
        "OK",
        "Cancel",
        // Registration overlay
        "Nickname:",
        "Password:",
        "Password (*):",
        "*: repeat",
        "Character:",
        "Gender:",
        "Email:",
        // About overlay
        "Somnio",
        "Version: %@",
        "Copyright",
        "Thanks paragraph",
        "3D characters and props by KayKit.",
        "Ghost model by Quaternius.",
        "Floor textures by ambientCG.",
        "UI borders by Kenney.",
        // Options overlay
        "Options",
        "Close",
        "Log level",
        "Default",
        "Debug",
        "Verbose",
        "Server URL",
        // Game menu overlay
        "Resume",
        "Leave Game",
        // Menu items
        "About Somnio",
        "Check for Updates...",
        // Auth-result inline errors (registration only — login failures route through
        // SomnioUI's chat scrollback as typed `ChatLine.badCredentials` /
        // `.alreadyLoggedIn` cases)
        "Nickname already exists.",
        "That name uses characters Somnio does not allow.",
        "Registration failed.",
        // Update-required overlay
        "Update required",
        "A newer version is available. Please update your client to keep playing.",
        "The server is being updated. Please try again in a few moments.",
        "Try Again"
    ]

    @Test func `catalog ships bilingual values with matching placeholders and no Unicode ellipsis`() throws {
        try assertCatalog(in: Bundle.module, expectedKeys: LocalizableCatalogTests.expectedKeys)
    }

    @Test func `runtime resolution returns the source string for menu keys`() {
        #expect(L.string("OK") == "OK")
    }
}
