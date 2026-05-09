import Foundation
import SomnioCore

/// Errors thrown by `SectorCache.load`. Both variants surface the offending file so an
/// operator can fix the input without grepping logs for the per-file load message.
public enum SectorCacheError: Error, Sendable, Equatable {
    case unreadable(URL)
    case parseFailed(name: String, underlying: MapCodecError)
}

/// In-memory holder for the parsed sector binaries the server serves at runtime.
///
/// The cache is populated once during boot via `load(from:)` and never re-read; sector
/// definitions are immutable for the lifetime of the process. The actor surface only
/// guards mutation during `load`; lookups by name are purely functional reads.
public actor SectorCache {
    private var sectorsByName: [String: Sector] = [:]

    public init() {}

    /// Reads every non-dotfile in `directoryURL`, parses it via `MapCodec.read`, and stores
    /// the result keyed by the bare filename (no extension) — sector files use the original's
    /// filename-as-sector-id convention so portal targets resolve without transformation.
    /// Throws on the first failure so startup fails closed.
    public func load(from directoryURL: URL) async throws {
        let entries: [URL]
        do {
            entries = try FileManager.default.contentsOfDirectory(
                at: directoryURL,
                includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles]
            )
        } catch {
            throw SectorCacheError.unreadable(directoryURL)
        }
        for entry in entries.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            let name = entry.deletingPathExtension().lastPathComponent
            let data: Data
            do {
                data = try Data(contentsOf: entry)
            } catch {
                throw SectorCacheError.unreadable(entry)
            }
            let body: SectorBody
            do {
                body = try MapCodec.read(data)
            } catch let error as MapCodecError {
                throw SectorCacheError.parseFailed(name: name, underlying: error)
            }
            sectorsByName[name] = Sector(body: body, name: name)
        }
    }

    public func sector(named name: String) -> Sector? {
        sectorsByName[name]
    }

    public func names() -> [String] {
        Array(sectorsByName.keys).sorted()
    }

    /// Snapshot used by `WorldRouter.init` to seed one `PerSectorActor` per loaded sector.
    public func snapshotByName() -> [String: Sector] {
        sectorsByName
    }
}
