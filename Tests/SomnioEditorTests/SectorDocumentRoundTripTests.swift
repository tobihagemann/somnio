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

    @MainActor @Test func `snapshot serializes the latest edit from off the main actor`() async throws {
        // AppKit's save machinery calls `snapshot(contentType:)` on a background queue
        // (autosave-in-place especially) — an isolation assumption here trapped on the
        // first autosave of an edited document, so pin the off-actor path explicitly.
        let document = SectorDocument()
        defer { SectorWorkspaceRegistry.discard(documentID: document.id) }
        document.renameSector(to: "Edited", undoManager: nil)
        document.mutate("Create new map", undoManager: nil) { body in
            body = SectorBody(
                version: 1,
                dimensions: GridSize(width: 2, height: 2),
                floorMaterialID: "grass-meadow",
                light: LightSetting(indoor: false, brightness: 100)
            )
        }
        let expected = SectorSnapshot(body: document.body, sectorName: document.sectorName)
        let snapshot = try await Task.detached {
            try document.snapshot(contentType: .somnioSector)
        }.value
        #expect(snapshot == expected)

        // A rename-only edit must refresh the mirror on its own — with the body edit
        // last (above), a stale `applySectorName` would otherwise hide behind
        // `applyMutation`'s refresh, shipping autosaves with an outdated filename.
        document.renameSector(to: "Renamed", undoManager: nil)
        let renamed = try await Task.detached {
            try document.snapshot(contentType: .somnioSector)
        }.value
        #expect(renamed == SectorSnapshot(body: expected.body, sectorName: "Renamed"))
    }
}
