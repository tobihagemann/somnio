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
        // Tool names
        "Select",
        "Object",
        "Mask",
        "Sector portal",
        "NPC",
        "Monster",
        // Game menu
        "Resume",
        "New Document",
        "Open...",
        "Preferences...",
        "Unsaved changes",
        // Inspector / overlay panel titles
        "Sector",
        "Selection",
        "Sector Settings",
        "Sector Settings...",
        "Create new map",
        "%lld selected",
        // Field labels
        "Bounded",
        "Light",
        "Sector name",
        "Script",
        "Direction",
        "Name",
        "Width",
        "Height",
        "X",
        "Y",
        "Indoor",
        "Model",
        "Floor material",
        "Priority",
        "Rotation",
        "Target sector",
        "Figure",
        "Facing",
        "Behavior",
        "Spawn HP",
        "Spawn balance",
        "Spawn mana",
        "Script index",
        "Box width",
        "Box height",
        "Mask width",
        "Mask height",
        "Monster width",
        "Monster height",
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
        "Fill in sector name!",
        "Invalid sector size!",
        // Undo action names
        "Place object",
        "Place collision mask",
        "Place sector portal",
        "Place NPC",
        "Place monster spawn",
        "Edit object",
        "Edit collision mask",
        "Edit sector portal",
        "Edit NPC",
        "Edit monster spawn",
        "Edit sector settings",
        "Move selection",
        "Resize selection",
        "Rotate NPC",
        "Paste",
        "Delete selection",
        "Rename sector",
        // Edit menu
        "Duplicate Selection",
        "Delete",
        // File menu
        "Save",
        "Save As...",
        "Duplicate",
        "Revert to Saved",
        "Import from server...",
        "Export to server...",
        // Dialog buttons / About
        "OK",
        "Cancel",
        "Apply",
        "Version: %@",
        "Copyright",
        "Thanks paragraph",
        "Script syntax: --- separates dialog steps; $name substitutes the player's nickname at runtime.",
        "Only behaviorTag 0 (greeter) is implemented server-side; other values fall through."
    ]

    @Test func `catalog ships bilingual values with matching placeholders and only Loading uses Unicode ellipsis`() throws {
        // Documented carve-out: every other user-visible string uses ASCII `...`; the editor's
        // `Loading…` window title is the one Unicode-`…` exception across the whole codebase.
        try assertCatalog(
            in: Bundle.module,
            expectedKeys: LocalizableCatalogTests.expectedKeys,
            allowedUnicodeEllipsisKeys: ["Loading\u{2026}"]
        )
    }

    @Test func `runtime resolution returns the source string for menu keys`() {
        // Pin the locale so the assertion holds regardless of the CI host's
        // language preferences (German preferences resolve "Grid" to "Raster").
        let locale = Locale(identifier: "en")
        #expect(L.string("OK", locale: locale) == "OK")
        #expect(L.string("Grid", locale: locale) == "Grid")
    }
}
