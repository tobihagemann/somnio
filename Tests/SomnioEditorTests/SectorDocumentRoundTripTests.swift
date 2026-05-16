import Foundation
import SomnioCore
import SomnioMapFixturesTestSupport
import Testing
@testable import SomnioEditor

struct SectorDocumentRoundTripTests {
    @Test(arguments: MapFixtures.Name.allCases)
    func `fixture round-trips through the codec helpers`(_ name: MapFixtures.Name) throws {
        // `init(configuration:)` and `fileWrapper(snapshot:configuration:)` can't be
        // exercised in unit tests because `ReadConfiguration` / `WriteConfiguration`
        // expose no public initializers; the pure helpers route through the same
        // `MapCodec.read` / `MapCodec.write` calls the file-API methods use.
        let originalData = try MapFixtures.data(name)
        let body = try SectorDocument.snapshot(from: originalData)
        let writtenData = try SectorDocument.data(for: body)
        let roundTripped = try SectorDocument.snapshot(from: writtenData)
        #expect(body == roundTripped)
    }

    @Test func `derives sector name from a path stripping the somnio-sector extension`() {
        #expect(SectorDocument.deriveSectorName(from: "EdariaArena.somnio-sector") == "EdariaArena")
        #expect(SectorDocument.deriveSectorName(from: "EdariaArena") == "EdariaArena")
        #expect(SectorDocument.deriveSectorName(from: nil) == "")
        #expect(SectorDocument.deriveSectorName(from: "") == "")
    }

    @MainActor @Test func `fresh document reports isUninitialized true`() {
        let document = SectorDocument()
        #expect(document.isUninitialized)
        #expect(document.sectorName.isEmpty)
        #expect(document.body.dimensions == .zero)
    }
}
