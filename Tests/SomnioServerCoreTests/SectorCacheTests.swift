import Foundation
import SomnioCore
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
        #expect(names == ["EdariaArena", "EdariaBibliothek", "EdariaMitte"])
        let bibliothek = await cache.sector(named: "EdariaBibliothek")
        let resolved = try #require(bibliothek)
        #expect(resolved.name == "EdariaBibliothek")
        #expect(resolved.light.indoor == true)
    }

    @Test func `snapshotByName returns one entry per loaded sector`() async throws {
        let cache = SectorCache()
        try await cache.load(from: Self.mapFixturesDirectory)
        let snapshot = await cache.snapshotByName()
        #expect(snapshot.count == 3)
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
}
