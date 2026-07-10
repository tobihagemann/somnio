#if canImport(Darwin)
    import Foundation
    import SomnioCatalogTestSupport
    import Testing

    struct CatalogCompilerTests {
        @Test(.enabled(if: CatalogCompiler.isAvailable))
        func `a malformed catalog throws compileFailed`() throws {
            let malformed = FileManager.default.temporaryDirectory
                .appendingPathComponent("\(UUID().uuidString).xcstrings")
            try Data("not a catalog".utf8).write(to: malformed)
            defer { try? FileManager.default.removeItem(at: malformed) }
            #expect(throws: CatalogCompilerError.compileFailed(status: 1)) {
                try CatalogCompiler.compileToTemporaryBundle(catalogAt: malformed)
            }
        }
    }
#endif
