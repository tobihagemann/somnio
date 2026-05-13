import Foundation
import Logging
import SomnioCore
import SomnioProtocol
import SomnioTestSupport
import Testing
@testable import SomnioServerCore

struct AdminCommandDispatcherTests {
    // MARK: - log / weblog read

    @Test func `log returns logEmpty when the file does not exist`() async throws {
        let directory = makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let dependencies = try await makeDependencies(logsDirectory: directory)
        let response = await AdminCommandDispatcher.handle(.log, dependencies: dependencies)
        #expect(response == .logEmpty)
    }

    @Test func `log returns logContents with the file body`() async throws {
        let directory = makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        try Data("hello\nworld".utf8).write(to: directory.appendingPathComponent("gameplay-log.log"))
        let dependencies = try await makeDependencies(logsDirectory: directory)
        let response = await AdminCommandDispatcher.handle(.log, dependencies: dependencies)
        guard case let .logContents(text) = response else {
            Issue.record("expected .logContents, got \(String(describing: response))")
            return
        }
        #expect(text == "hello\nworld")
    }

    @Test func `log oversized payload encodes through the wire`() async throws {
        let directory = makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        // 70000 bytes of "ü" (each 2 UTF-8 bytes) so the cut lands near a multi-byte
        // boundary; the truncation helper must advance forward to the next codepoint.
        let body = String(repeating: "ü", count: 35000)
        #expect(body.utf8.count == 70000)
        try Data(body.utf8).write(to: directory.appendingPathComponent("gameplay-log.log"))
        let dependencies = try await makeDependencies(logsDirectory: directory)
        let response = await AdminCommandDispatcher.handle(.log, dependencies: dependencies)
        guard case let .logContents(text) = response else {
            Issue.record("expected .logContents, got \(String(describing: response))")
            return
        }
        #expect(text.utf8.count <= Int(UInt16.max))
        #expect(text.hasSuffix("ü"))
        _ = try BinaryEncoder().encode(AdminResponse.logContents(text: text))
    }

    @Test func `log truncation keeps the trailing window, not the leading prefix`() async throws {
        // Operators reading the log want the most recent lines, so a regression that
        // returned the leading prefix instead of the trailing tail would silently hide
        // the events they care about. The uniform "ü" oversize test above can't see
        // the difference; this fixture uses distinct sentinels at the two ends.
        let directory = makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let head = "HEAD-SENTINEL "
        let tail = "TAIL-SENTINEL"
        // Pad to well past UInt16.max so truncation must drop something. 80 000 bytes
        // of filler comfortably exceeds 65 535.
        let filler = String(repeating: "x", count: 80000)
        let body = head + filler + tail
        try Data(body.utf8).write(to: directory.appendingPathComponent("gameplay-log.log"))
        let dependencies = try await makeDependencies(logsDirectory: directory)
        let response = await AdminCommandDispatcher.handle(.log, dependencies: dependencies)
        guard case let .logContents(text) = response else {
            Issue.record("expected .logContents, got \(String(describing: response))")
            return
        }
        #expect(text.utf8.count <= Int(UInt16.max))
        #expect(text.hasSuffix(tail))
        #expect(text.contains(head) == false)
    }

    @Test func `log non UTF8 contents fall back to logEmpty`() async throws {
        // The dispatcher decodes the on-disk bytes via `String(data:encoding:.utf8)`;
        // a malformed file (e.g., a corrupted rotated log) must surface as `.logEmpty`
        // and not propagate as a decode crash or as `.logContents(text: "")` (which
        // would imply the file exists but is empty).
        let directory = makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        // Lone continuation byte (0xFF, 0xFE) — invalid UTF-8 head.
        try Data([0xFF, 0xFE, 0xFF]).write(to: directory.appendingPathComponent("gameplay-log.log"))
        let dependencies = try await makeDependencies(logsDirectory: directory)
        let response = await AdminCommandDispatcher.handle(.log, dependencies: dependencies)
        #expect(response == .logEmpty)
    }

    @Test func `logRemove deletes the file and returns logRemoved`() async throws {
        let directory = makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("gameplay-log.log")
        let writer = FileLogWriter.shared(directory: directory, fileName: "gameplay-log.log")
        writer.write("primed\n")
        #expect(FileManager.default.fileExists(atPath: file.path))

        let dependencies = try await makeDependencies(logsDirectory: directory)
        let response = await AdminCommandDispatcher.handle(.logRemove, dependencies: dependencies)
        #expect(response == .logRemoved)
        #expect(FileManager.default.fileExists(atPath: file.path) == false)

        writer.write("after-rm\n")
        #expect(FileManager.default.fileExists(atPath: file.path))
        let contents = try String(contentsOf: file, encoding: .utf8)
        #expect(contents == "after-rm\n")
    }

    @Test func `weblog returns weblogEmpty when missing and weblogContents when populated`() async throws {
        let directory = makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let dependencies = try await makeDependencies(logsDirectory: directory)

        let empty = await AdminCommandDispatcher.handle(.weblog, dependencies: dependencies)
        #expect(empty == .weblogEmpty)

        try Data("admin-line".utf8).write(to: directory.appendingPathComponent("admin-log.log"))
        let populated = await AdminCommandDispatcher.handle(.weblog, dependencies: dependencies)
        #expect(populated == .weblogContents(text: "admin-line"))
    }

    @Test func `weblogRemove deletes the admin file and returns weblogRemoved`() async throws {
        let directory = makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let writer = FileLogWriter.shared(directory: directory, fileName: "admin-log.log")
        writer.write("primed\n")
        let dependencies = try await makeDependencies(logsDirectory: directory)
        let response = await AdminCommandDispatcher.handle(.weblogRemove, dependencies: dependencies)
        #expect(response == .weblogRemoved)
        #expect(FileManager.default.fileExists(atPath: directory.appendingPathComponent("admin-log.log").path) == false)
    }

    // MARK: - players / time

    @Test func `players returns playerCount text`() async throws {
        let router = StubAdminWorldRouter()
        await router.setPlayerCount(7)
        let dependencies = try await makeDependencies(worldRouter: router)
        let response = await AdminCommandDispatcher.handle(.players, dependencies: dependencies)
        #expect(response == .playerCount(text: "7"))
    }

    @Test func `time formats the wire payload as Y;M;D;HH;MM;SS`() async throws {
        let dependencies = try await AdminRouteTestApplication.makeDependencies(
            worldRouter: StubAdminWorldRouter(),
            logsDirectory: makeTempDirectory(),
            initialClock: WorldClock(second: 7, minute: 5, hour: 0, day: 1, month: 1, year: 1)
        )
        let response = await AdminCommandDispatcher.handle(.time, dependencies: dependencies)
        #expect(response == .worldClock(text: "1;1;1;00;05;07"))
    }

    // MARK: - say

    @Test func `say broadcasts and returns sayBroadcast`() async throws {
        let router = StubAdminWorldRouter()
        let dependencies = try await makeDependencies(worldRouter: router)
        let response = await AdminCommandDispatcher.handle(.say(text: "hello"), dependencies: dependencies)
        #expect(response == .sayBroadcast(text: "hello"))
        let broadcasts = await router.recordedBroadcasts()
        #expect(broadcasts.count == 1)
        if case let .adminSay(payload) = broadcasts.first {
            #expect(payload.text == "hello")
        } else {
            Issue.record("expected .adminSay broadcast, got \(String(describing: broadcasts.first))")
        }
    }

    @Test func `say empty text returns nil and records no broadcast`() async throws {
        let router = StubAdminWorldRouter()
        let dependencies = try await makeDependencies(worldRouter: router)
        let response = await AdminCommandDispatcher.handle(.say(text: ""), dependencies: dependencies)
        #expect(response == nil)
        let broadcasts = await router.recordedBroadcasts()
        #expect(broadcasts.isEmpty)
    }

    // MARK: - kick

    @Test func `kick of a match returns kickedPlayer`() async throws {
        let router = StubAdminWorldRouter()
        await router.setKickOutcome(true)
        let dependencies = try await makeDependencies(worldRouter: router)
        let response = await AdminCommandDispatcher.handle(.kick(name: "Saibot"), dependencies: dependencies)
        #expect(response == .kickedPlayer(text: "Saibot"))
    }

    @Test func `kick of a miss returns kickedPlayerNotFound`() async throws {
        let router = StubAdminWorldRouter()
        await router.setKickOutcome(false)
        let dependencies = try await makeDependencies(worldRouter: router)
        let response = await AdminCommandDispatcher.handle(.kick(name: "Saibot"), dependencies: dependencies)
        #expect(response == .kickedPlayerNotFound(text: "Saibot"))
    }

    @Test func `kick of an empty name returns kickedPlayerNotFound with empty text`() async throws {
        let router = StubAdminWorldRouter()
        await router.setKickOutcome(false)
        let dependencies = try await makeDependencies(worldRouter: router)
        let response = await AdminCommandDispatcher.handle(.kick(name: ""), dependencies: dependencies)
        #expect(response == .kickedPlayerNotFound(text: ""))
    }

    // MARK: - version

    @Test func `version returns the bag's serverVersion`() async throws {
        let dependencies = try await makeDependencies(serverVersion: "9.9.9")
        let response = await AdminCommandDispatcher.handle(.version, dependencies: dependencies)
        #expect(response == .versionString(text: "9.9.9"))
    }

    // MARK: - Helpers

    private func makeTempDirectory() -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func makeDependencies(
        worldRouter: any AdminWorldRouter = StubAdminWorldRouter(),
        serverVersion: String = "1.0.0",
        logsDirectory: URL? = nil
    ) async throws -> AdminConnectionDependencies {
        try await AdminRouteTestApplication.makeDependencies(
            worldRouter: worldRouter,
            serverVersion: serverVersion,
            logsDirectory: logsDirectory ?? makeTempDirectory()
        )
    }
}
