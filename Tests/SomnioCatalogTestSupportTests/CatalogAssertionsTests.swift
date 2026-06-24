import Foundation
import SomnioCatalogTestSupport
import Testing

struct CatalogAssertionsTests {
    @Test func `well-formed bilingual catalog passes`() throws {
        try assertCatalog(
            ["OK": ["en": "OK", "de": "OK"], "Greeting %@": ["en": "Hi %@", "de": "Hallo %@"]],
            expectedKeys: ["OK", "Greeting %@"]
        )
    }

    @Test func `missing key throws missingKey`() {
        #expect(throws: CatalogValidationError.missingKey("Absent")) {
            try assertCatalog(["OK": ["en": "OK", "de": "OK"]], expectedKeys: ["Absent"])
        }
    }

    @Test func `missing English value throws missingLocaleValue`() {
        #expect(throws: CatalogValidationError.missingLocaleValue(key: "OK", locale: "en")) {
            try assertCatalog(["OK": ["de": "OK"]], expectedKeys: ["OK"])
        }
    }

    @Test func `missing German value throws missingLocaleValue`() {
        #expect(throws: CatalogValidationError.missingLocaleValue(key: "OK", locale: "de")) {
            try assertCatalog(["OK": ["en": "OK"]], expectedKeys: ["OK"])
        }
    }

    @Test func `an empty locale value throws missingLocaleValue`() {
        #expect(throws: CatalogValidationError.missingLocaleValue(key: "OK", locale: "de")) {
            try assertCatalog(["OK": ["en": "OK", "de": ""]], expectedKeys: ["OK"])
        }
    }

    @Test func `placeholder signature mismatch throws placeholderMismatch`() {
        #expect(throws: CatalogValidationError.placeholderMismatch(key: "Msg", english: "Hi %@", german: "Hallo")) {
            try assertCatalog(["Msg": ["en": "Hi %@", "de": "Hallo"]], expectedKeys: ["Msg"])
        }
    }

    @Test func `a value carrying a Unicode ellipsis throws`() {
        #expect(throws: CatalogValidationError.unicodeEllipsisInValue(key: "Loading", locale: "en", value: "Loading\u{2026}")) {
            try assertCatalog(["Loading": ["en": "Loading\u{2026}", "de": "Laedt"]], expectedKeys: ["Loading"])
        }
    }

    @Test func `a key carrying a Unicode ellipsis with ASCII values still throws`() {
        // Regression guard: the shared helper must scan keys, not only values — the editor's
        // prior inline check rejected a key-level ellipsis, and migrating onto the helper must
        // not silently drop that.
        #expect(throws: CatalogValidationError.unicodeEllipsisInKey("Save\u{2026}")) {
            try assertCatalog(["Save\u{2026}": ["en": "Save...", "de": "Speichern..."]], expectedKeys: ["Save\u{2026}"])
        }
    }

    @Test func `an allowed key may carry a Unicode ellipsis`() throws {
        try assertCatalog(
            ["Loading\u{2026}": ["en": "Loading\u{2026}", "de": "Ladevorgang\u{2026}"]],
            expectedKeys: ["Loading\u{2026}"],
            allowedUnicodeEllipsisKeys: ["Loading\u{2026}"]
        )
    }
}
