#if canImport(Darwin)
    import Foundation
    import SomnioCatalogTestSupport
    import Testing
    @testable import SomnioCore

    struct CatalogRuntimeResolutionTests {
        // `String(localized:bundle:locale:)` cannot select the localization table (the
        // `locale:` argument only formats interpolated values; table selection follows the
        // process's preferred languages), so each compiled `<lang>.lproj` is loaded as its
        // own bundle to pin the locale deterministically. Asserting both locales proves the
        // check distinguishes the tables instead of reading ambient state, and the `value:`
        // sentinel separates a missing-key regression from a key leak.
        @Test(.enabled(if: CatalogCompiler.isAvailable))
        func `compiled catalog resolves German where the raw xcstrings cannot`() throws {
            let catalogURL = try #require(
                Bundle.somnioCoreModule.url(forResource: "Localizable", withExtension: "xcstrings")
            )
            let compiledBundle = try CatalogCompiler.compileToTemporaryBundle(catalogAt: catalogURL)
            defer { try? FileManager.default.removeItem(at: compiledBundle) }
            let germanBundle = try #require(Bundle(url: compiledBundle.appendingPathComponent("de.lproj")))
            let englishBundle = try #require(Bundle(url: compiledBundle.appendingPathComponent("en.lproj")))
            #expect(germanBundle.localizedString(forKey: "Male", value: "MISS", table: nil) == "Männlich")
            #expect(englishBundle.localizedString(forKey: "Male", value: "MISS", table: nil) == "Male")
        }
    }
#endif
