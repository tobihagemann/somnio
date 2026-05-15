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

    @Test func `runtime resolution returns the source string for menu keys`() {
        #expect(L.string("OK") == "OK")
    }
}
