import Foundation
import SomnioCatalogTestSupport
import Testing
@testable import SomnioEditor

struct LocalizableCatalogTests {
    private static let expectedKeys: [String] = [
        // Window / scene titles
        "Somnio Editor",
        "About Somnio Editor",
        "Loading…",
        // Placement-mode names
        "Object",
        "Mask",
        "Sector portal",
        "Spawn",
        // Field labels
        "Bounded",
        "Light",
        "Sector name",
        "Script",
        "Type",
        "Direction",
        "Name",
        "Width",
        "Height",
        "X",
        "Y",
        "Indoor",
        "Tileset",
        "Source X",
        "Source Y",
        "Source width",
        "Source height",
        "Priority",
        "Target sector",
        "Figure",
        "Behavior",
        "Spawn HP",
        "Spawn balance",
        "Spawn mana",
        "Script index",
        "NPC",
        "Monster",
        // Direction picker labels
        "Direction.north",
        "Direction.east",
        "Direction.south",
        "Direction.west",
        // Option captions
        "Yes",
        "No",
        "Outbound trigger",
        "Arrival placement",
        "Tiled (32x32)",
        "Tiled (16x16)",
        "Tiled (8x8)",
        "Tiled (4x4)",
        "Free",
        "Grid",
        "Grid snap",
        // Validation strings
        "Fill in light!",
        "Fill in sector name!",
        "Fill in NPC name!",
        "Fill in all monster values!",
        "Fill in monster name!",
        // Undo action names
        "Place object",
        "Place collision mask",
        "Place sector portal",
        "Place NPC",
        "Place monster spawn",
        "Create new map",
        "Delete selection",
        "Rename sector",
        // File menu
        "Save",
        "Save As...",
        "Duplicate",
        "Revert to Saved",
        "Import from server...",
        "Export to server...",
        "Edit script...",
        // About sheet / menu
        "OK",
        "Cancel",
        "Version: %@",
        "Copyright",
        "Thanks paragraph",
        "Script syntax: --- separates dialog steps; $name substitutes the player's nickname at runtime.",
        "Only behaviorTag 0 (greeter) is implemented server-side; other values fall through."
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

    @Test func `loading is the only catalog entry permitted to use Unicode ellipsis`() throws {
        // Documented carve-out: every other user-visible string uses ASCII `...`; the
        // editor's `Loading…` window title is the one Unicode-`…` exception across the
        // whole codebase.
        let catalog = try CatalogParser.parse(from: Bundle.module)
        for (key, entry) in catalog {
            let hasU2026 = key.contains("\u{2026}") || entry.values.contains(where: { $0.contains("\u{2026}") })
            if hasU2026 {
                #expect(key == "Loading\u{2026}", "unexpected Unicode ellipsis in \(key)")
            }
        }
    }

    @Test func `runtime resolution returns the source string for menu keys`() {
        // Pin the locale so the assertion holds regardless of the CI host's
        // language preferences (German preferences resolve "Grid" to "Raster").
        let locale = Locale(identifier: "en")
        #expect(L.string("OK", locale: locale) == "OK")
        #expect(L.string("Grid", locale: locale) == "Grid")
    }
}
