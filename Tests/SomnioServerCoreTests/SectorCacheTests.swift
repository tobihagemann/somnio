import Foundation
import SomnioCore
import SomnioData
import SomnioMapFixturesTestSupport
import Testing
@testable import SomnioServerCore

struct SectorCacheTests {
    private static let mapFixturesDirectory: URL = MapFixtures.directoryURL

    private static let corruptDirectory: URL = Bundle.module.url(forResource: "Corrupt", withExtension: nil)!

    @Test func `load reads every shipped sector and keys by bare filename`() async throws {
        let cache = SectorCache()
        try await cache.load(from: Self.mapFixturesDirectory)
        let names = await cache.names()
        #expect(names == ["EdariaArena", "EdariaBibliothek", "EdariaInn", "EdariaMitte", "EdariaShop", "Nordwald", "Nordwiese"])
        let bibliothek = await cache.sector(named: "EdariaBibliothek")
        let resolved = try #require(bibliothek)
        #expect(resolved.name == "EdariaBibliothek")
        #expect(resolved.light.indoor == true)
    }

    @Test func `snapshotByName returns one entry per loaded sector`() async throws {
        let cache = SectorCache()
        try await cache.load(from: Self.mapFixturesDirectory)
        let snapshot = await cache.snapshotByName()
        #expect(snapshot.count == 7)
        #expect(snapshot["EdariaArena"]?.monsterSpawns.count == 1)
    }

    @Test func `unknown sector lookup returns nil`() async throws {
        let cache = SectorCache()
        try await cache.load(from: Self.mapFixturesDirectory)
        let missing = await cache.sector(named: "DoesNotExist")
        #expect(missing == nil)
    }

    @Test func `parse failure surfaces SectorCacheError parseFailed with sector name`() async throws {
        let cache = SectorCache()
        do {
            try await cache.load(from: Self.corruptDirectory)
            Issue.record("expected SectorCacheError.parseFailed")
        } catch let SectorCacheError.parseFailed(name, _) {
            #expect(name == "Truncated")
        }
    }

    @Test func `unreadable directory surfaces SectorCacheError unreadable`() async throws {
        let cache = SectorCache()
        let bogus = URL(fileURLWithPath: "/var/empty/does-not-exist-\(UUID().uuidString)", isDirectory: true)
        do {
            try await cache.load(from: bogus)
            Issue.record("expected SectorCacheError.unreadable")
        } catch let SectorCacheError.unreadable(url) {
            #expect(url == bogus)
        }
    }

    @Test func `directory without somnio-sector files loads an empty snapshot`() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("SectorCacheTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        // A stale binary-only sector (no `.somnio-sector` extension) must be skipped, not loaded.
        try Data([0x00]).write(to: directory.appendingPathComponent("EdariaMitte"))

        let cache = SectorCache()
        try await cache.load(from: directory)
        let snapshot = await cache.snapshotByName()
        #expect(snapshot.isEmpty)
    }

    @Test func `requireSectorsLoaded throws on empty and returns on non-empty`() throws {
        #expect(throws: ServerStartupError.noSectorsLoaded) {
            try requireSectorsLoaded([])
        }
        #expect(throws: Never.self) {
            try requireSectorsLoaded(["EdariaMitte"])
        }
    }
}
