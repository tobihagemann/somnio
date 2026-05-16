import Foundation

/// Shared accessor for the record-type sector fixtures (`EdariaArena`, `EdariaBibliothek`,
/// `EdariaMitte`). Lives in a stand-alone resource target so unit tests in `SomnioCoreTests`,
/// `SomnioServerCoreTests`, and `SomnioEditorTests` can load the same bytes without each
/// target shipping its own `.copy` of the fixture directory. Integration tests in the sibling
/// SwiftPM package reach the same files via a relative filesystem path; this helper only
/// exposes the in-target `Bundle.module` view.
public enum MapFixtures {
    public enum Name: String, CaseIterable, Sendable {
        case edariaArena = "EdariaArena"
        case edariaBibliothek = "EdariaBibliothek"
        case edariaMitte = "EdariaMitte"
    }

    public enum FixtureError: Error, Equatable, Sendable {
        case notFound(String)
    }

    /// Returns the bytes of the named fixture loaded from this target's resource bundle.
    public static func data(_ name: Name) throws -> Data {
        guard let url = Bundle.module.url(forResource: name.rawValue, withExtension: nil, subdirectory: "MapFixtures") else {
            throw FixtureError.notFound(name.rawValue)
        }
        return try Data(contentsOf: url)
    }

    /// Directory URL of the bundled `MapFixtures` folder. Consumed by `SectorCacheTests`
    /// which scans the directory rather than reading individual files; also useful for any
    /// future test that walks `FileManager.default.contentsOfDirectory(at:)`.
    public static var directoryURL: URL {
        guard let url = Bundle.module.url(forResource: "MapFixtures", withExtension: nil) else {
            fatalError("MapFixtures directory missing from SomnioMapFixturesTestSupport bundle")
        }
        return url
    }
}
