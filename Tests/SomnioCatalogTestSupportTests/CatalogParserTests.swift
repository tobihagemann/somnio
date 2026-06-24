import Foundation
import SomnioCatalogTestSupport
import Testing

struct CatalogParserTests {
    @Test func `missing resource throws missing`() throws {
        try withBundle(files: [:]) { bundle in
            #expect(throws: CatalogParserError.missing) {
                try CatalogParser.parse(from: bundle)
            }
        }
    }

    @Test func `malformed top-level JSON throws malformedJSON`() throws {
        try withBundle(files: ["Localizable.xcstrings": "[\"not an object\"]"]) { bundle in
            #expect(throws: CatalogParserError.malformedJSON) {
                try CatalogParser.parse(from: bundle)
            }
        }
    }

    @Test func `JSON without strings key throws malformedJSON`() throws {
        try withBundle(files: ["Localizable.xcstrings": #"{"sourceLanguage":"en","version":"1.0"}"#]) { bundle in
            #expect(throws: CatalogParserError.malformedJSON) {
                try CatalogParser.parse(from: bundle)
            }
        }
    }

    @Test func `well-formed but empty catalog returns an empty dictionary`() throws {
        try withBundle(
            files: ["Localizable.xcstrings": #"{"sourceLanguage":"en","version":"1.0","strings":{}}"#]
        ) { bundle in
            let catalog = try CatalogParser.parse(from: bundle)
            #expect(catalog.isEmpty)
        }
    }

    @Test func `entries without a localizations block are dropped silently`() throws {
        let json = #"""
        {
          "sourceLanguage": "en",
          "version": "1.0",
          "strings": {
            "Translated": {
              "localizations": {
                "en": {"stringUnit": {"state": "translated", "value": "Hello"}}
              }
            },
            "Stub": {
              "extractionState": "manual"
            }
          }
        }
        """#
        try withBundle(files: ["Localizable.xcstrings": json]) { bundle in
            let catalog = try CatalogParser.parse(from: bundle)
            #expect(catalog["Translated"] == ["en": "Hello"])
            #expect(catalog["Stub"] == nil)
        }
    }

    @Test func `localization entries with missing stringUnit are skipped`() throws {
        let json = #"""
        {
          "sourceLanguage": "en",
          "version": "1.0",
          "strings": {
            "Mixed": {
              "localizations": {
                "en": {"stringUnit": {"state": "translated", "value": "Hello"}},
                "de": {"stringUnit": {"state": "new"}},
                "fr": "not a dictionary"
              }
            }
          }
        }
        """#
        try withBundle(files: ["Localizable.xcstrings": json]) { bundle in
            let catalog = try CatalogParser.parse(from: bundle)
            #expect(catalog["Mixed"] == ["en": "Hello"])
        }
    }

    /// Creates a `.bundle` directory under `$TMPDIR`, writes the supplied files into it,
    /// runs `body` with a `Bundle` rooted at that directory, and removes the directory
    /// on the way out. Encapsulates the temp-file lifecycle so test bodies stay focused
    /// on the assertion.
    private func withBundle(files: [String: String], body: (Bundle) throws -> Void) throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(
            "CatalogParserTests-\(UUID().uuidString).bundle",
            isDirectory: true
        )
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: url) }
        for (name, contents) in files {
            try contents.write(to: url.appendingPathComponent(name), atomically: true, encoding: .utf8)
        }
        let bundle = try #require(Bundle(url: url))
        try body(bundle)
    }
}
