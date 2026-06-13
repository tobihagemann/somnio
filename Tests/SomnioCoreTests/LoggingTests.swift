import Foundation
import Logging
import Synchronization
import Testing
@testable import SomnioCore

// Coverage for the small but load-bearing pieces of the logging surface: JSON line emission,
// label parsing, prefix-based label filtering, and rotating-file-writer rotation.

struct LoggingTests {
    private func parseJSONLine(_ line: String) throws -> [String: Any] {
        let object = try JSONSerialization.jsonObject(with: Data(line.utf8))
        return try #require(object as? [String: Any])
    }

    @Test func `JSON line carries the core fields and a trailing newline`() throws {
        let handler = JSONLogHandler(label: "de.tobiha.somnio.test")
        let line = try #require(handler.jsonLine(for: LogEvent(
            level: .info, message: "hello", metadata: nil,
            source: "test", file: #file, function: #function, line: #line
        )))
        #expect(line.hasSuffix("}\n"))
        let object = try parseJSONLine(line)
        #expect(object["level"] as? String == "info")
        #expect(object["label"] as? String == "de.tobiha.somnio.test")
        #expect(object["message"] as? String == "hello")
        #expect(object["ts"] is String)
        #expect(object["error"] == nil)
        #expect(object["metadata"] == nil)
    }

    @Test func `JSON line escapes specials and round-trips them`() throws {
        let handler = JSONLogHandler(label: "t")
        let tricky = "\"quoted\" back\\slash\nnewline\ttab\u{01}ctrl /slash/ Lädiert 🐉"
        let line = try #require(handler.jsonLine(for: LogEvent(
            level: .error, message: "\(tricky)", metadata: nil,
            source: "t", file: #file, function: #function, line: #line
        )))
        // Forward slashes stay unescaped (`.withoutEscapingSlashes`).
        #expect(line.contains("/slash/"))
        let object = try parseJSONLine(line)
        #expect(object["message"] as? String == tricky)
    }

    @Test func `JSON line includes error and lexically sorted metadata`() throws {
        var handler = JSONLogHandler(label: "t")
        handler.metadata = ["zebra": "z"]
        let line = try #require(handler.jsonLine(for: LogEvent(
            level: .warning, message: "m", error: LogTestError(description: "boom"),
            metadata: ["alpha": "a"], source: "t", file: #file, function: #function, line: #line
        )))
        #expect(line.contains("\"metadata\":{\"alpha\":\"a\",\"zebra\":\"z\"}"))
        let object = try parseJSONLine(line)
        #expect(object["error"] as? String == "boom")
        #expect(object["metadata"] as? [String: String] == ["alpha": "a", "zebra": "z"])
    }

    #if canImport(OSLog)
        @Test func `OSLog label split on last dot`() {
            let parsed = OSLogHandler.parseLabel("de.tobiha.somnio.app.lifecycle")
            #expect(parsed.subsystem == "de.tobiha.somnio.app")
            #expect(parsed.category == "lifecycle")
        }

        @Test func `OSLog label fallback when no dot`() {
            let parsed = OSLogHandler.parseLabel("standalone")
            #expect(parsed.subsystem == "standalone")
            #expect(parsed.category == "standalone")
        }
    #endif

    // MARK: - Label filtering

    private final class CapturingHandler: LogHandler, Sendable {
        // Captured messages live behind a `Mutex` so the handler is `Sendable` without
        // `@unchecked`. The other `LogHandler` requirements (`logLevel`, `metadata`,
        // `metadataProvider`, the metadata subscript) have no concurrent access in the
        // tests, so we satisfy the protocol with no-op accessors instead of paying for a
        // `Mutex` per property.
        private let captured = Mutex<[String]>([])
        var seen: [String] {
            captured.withLock { $0 }
        }

        var logLevel: Logger.Level {
            get { .trace }
            set { _ = newValue }
        }

        var metadata: Logger.Metadata {
            get { [:] }
            set { _ = newValue }
        }

        var metadataProvider: Logger.MetadataProvider? {
            get { nil }
            set { _ = newValue }
        }

        subscript(metadataKey key: String) -> Logger.Metadata.Value? {
            get { nil }
            set { _ = newValue }
        }

        func log(event: LogEvent) {
            captured.withLock { $0.append(event.message.description) }
        }
    }

    private func makeFilter(_ label: String, prefixes: [String]) -> (LabelFilteringLogHandler, CapturingHandler) {
        let inner = CapturingHandler()
        let wrapper = LabelFilteringLogHandler(label: label, prefixes: prefixes, inner: inner)
        return (wrapper, inner)
    }

    private func emit(_ wrapper: LabelFilteringLogHandler, message: String) {
        var w = wrapper
        w.log(event: LogEvent(level: .info, message: "\(message)", metadata: nil,
                              source: "test", file: #file, function: #function, line: #line))
    }

    @Test func `label filter forwards matching prefix`() {
        let (wrapper, inner) = makeFilter("de.tobiha.somnio.server.gameplay.tick",
                                          prefixes: ["de.tobiha.somnio.server.gameplay"])
        emit(wrapper, message: "hello")
        #expect(inner.seen == ["hello"])
    }

    @Test func `label filter drops non-matching prefix`() {
        let (wrapper, inner) = makeFilter("de.tobiha.somnio.app.lifecycle",
                                          prefixes: ["de.tobiha.somnio.server.gameplay"])
        emit(wrapper, message: "hello")
        #expect(inner.seen.isEmpty)
    }

    @Test func `label filter forwards across any of multiple prefixes`() {
        let (wrapper, inner) = makeFilter("de.tobiha.somnio.server.admin.kick",
                                          prefixes: [
                                              "de.tobiha.somnio.server.gameplay",
                                              "de.tobiha.somnio.server.admin"
                                          ])
        emit(wrapper, message: "kick")
        #expect(inner.seen == ["kick"])
    }

    @Test func `label filter with empty prefix list drops everything`() {
        let (wrapper, inner) = makeFilter("anything", prefixes: [])
        emit(wrapper, message: "x")
        #expect(inner.seen.isEmpty)
    }

    // MARK: - File log writer rotation

    @Test func `file log writer rotates and prunes archives`() throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("somnio-log-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let writer = FileLogWriter(
            directory: tmp,
            fileName: "test.log",
            maxFileSize: 16, // tiny, so each line triggers rotation
            maxArchivedFiles: 2
        )

        // Each line is >16 bytes, so every write triggers rotation. After five writes plus
        // one short trailing write to populate a fresh current, the archive cap should hold.
        for i in 0 ..< 5 {
            writer.write("line \(i) padding padding\n")
        }
        writer.write("ok\n")

        let fm = FileManager.default
        #expect(fm.fileExists(atPath: writer.currentLogFile.path))
        #expect(fm.fileExists(atPath: writer.archivedFile(index: 1).path))
        #expect(fm.fileExists(atPath: writer.archivedFile(index: 2).path))
        #expect(!fm.fileExists(atPath: writer.archivedFile(index: 3).path))
    }

    @Test func `closeAndRemove deletes the active log and clears the cached handle`() throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("somnio-log-rm-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let writer = FileLogWriter(directory: tmp, fileName: "rm.log")
        writer.write("primed\n")
        #expect(FileManager.default.fileExists(atPath: writer.currentLogFile.path))

        let removed = writer.closeAndRemove()
        #expect(removed)
        #expect(FileManager.default.fileExists(atPath: writer.currentLogFile.path) == false)

        // The next write must re-open the file cleanly. If `closeAndRemove` had left the
        // cached `FileHandle` alive, this write would stream into the unlinked inode and
        // the new file would stay empty.
        writer.write("after-rm\n")
        let after = try String(contentsOf: writer.currentLogFile, encoding: .utf8)
        #expect(after == "after-rm\n")
    }

    @Test func `closeAndRemove returns false when no log file exists yet`() throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("somnio-log-absent-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let writer = FileLogWriter(directory: tmp, fileName: "absent.log")
        // The writer was never primed, so `currentLogFile` does not exist on disk.
        #expect(FileManager.default.fileExists(atPath: writer.currentLogFile.path) == false)
        let removed = writer.closeAndRemove()
        #expect(removed == false)
    }

    @Test func `closeAndRemove also wipes rotated archives`() throws {
        // Operator-visible semantics of `log rm` / `weblog rm` are "the log is gone",
        // so the writer expunges every rotated copy in the same lock. A partial wipe
        // would leave the bytes that motivated the `rm` on disk in `<base>.1.log`.
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("somnio-log-rm-archives-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let writer = FileLogWriter(
            directory: tmp,
            fileName: "rotate.log",
            maxFileSize: 16,
            maxArchivedFiles: 2
        )
        for index in 0 ..< 3 {
            writer.write("line \(index) padding padding\n")
        }
        // Confirm we actually have at least one archive on disk before removing.
        #expect(FileManager.default.fileExists(atPath: writer.archivedFile(index: 1).path))

        _ = writer.closeAndRemove()
        // Active log and every archive in `[1, maxArchivedFiles]` are gone.
        #expect(FileManager.default.fileExists(atPath: writer.currentLogFile.path) == false)
        #expect(FileManager.default.fileExists(atPath: writer.archivedFile(index: 1).path) == false)
        #expect(FileManager.default.fileExists(atPath: writer.archivedFile(index: 2).path) == false)
    }

    @Test func `file log writer shared cache returns same instance per path`() {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
        let a = FileLogWriter.shared(directory: tmp, fileName: "shared-\(UUID().uuidString).log")
        let b = FileLogWriter.shared(directory: tmp, fileName: a.currentLogFile.lastPathComponent)
        #expect(a === b)
    }

    @Test func `file log writer serializes concurrent writes`() async throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("somnio-log-concurrent-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        // Generously sized so no rotation kicks in mid-test; the regression we want to catch
        // is interleaved writes from competing tasks producing torn / partial lines.
        let writer = FileLogWriter(
            directory: tmp,
            fileName: "concurrent.log",
            maxFileSize: 10_000_000,
            maxArchivedFiles: 1
        )

        let writes = 200
        await withTaskGroup(of: Void.self) { group in
            for i in 0 ..< writes {
                group.addTask {
                    writer.write("line \(i) padding so each line is comfortably long\n")
                }
            }
        }

        let contents = try String(contentsOf: writer.currentLogFile, encoding: .utf8)
        let lines = contents.split(separator: "\n", omittingEmptySubsequences: true)
        #expect(lines.count == writes)
        for line in lines {
            #expect(line.hasPrefix("line "))
            #expect(line.contains(" padding so each line is comfortably long"))
        }
    }

    // MARK: - LogMetadata

    @Test func `merged metadata follows handler then provider then event order`() {
        let merged = LogMetadata.merged(
            handler: ["a": "h", "b": "h"],
            provider: ["b": "p", "c": "p"],
            event: ["c": "e", "d": "e"]
        )
        // a only in handler → "h"; b: handler then overwritten by provider → "p";
        // c: provider then overwritten by event → "e"; d only in event → "e".
        #expect(merged["a"] == "h")
        #expect(merged["b"] == "p")
        #expect(merged["c"] == "e")
        #expect(merged["d"] == "e")
    }

    @Test func `merged metadata returns handler when provider and event empty`() {
        let merged = LogMetadata.merged(
            handler: ["only": "handler"],
            provider: nil,
            event: nil
        )
        #expect(merged == ["only": "handler"])
    }

    @Test func `flat text suffix is empty when nothing to render`() {
        #expect(LogMetadata.flatTextSuffix(merged: [:], error: nil) == "")
    }

    @Test func `flat text suffix sorts metadata keys alphabetically`() {
        let suffix = LogMetadata.flatTextSuffix(
            merged: ["zebra": "z", "alpha": "a", "mango": "m"],
            error: nil
        )
        #expect(suffix == " alpha=a mango=m zebra=z")
    }

    private struct LogTestError: Error, CustomStringConvertible {
        let description: String
    }

    @Test func `flat text suffix appends error after metadata`() {
        let suffix = LogMetadata.flatTextSuffix(
            merged: ["k": "v"],
            error: LogTestError(description: "boom")
        )
        #expect(suffix == " k=v error=boom")
    }

    @Test func `flat text suffix renders error alone`() {
        let suffix = LogMetadata.flatTextSuffix(
            merged: [:],
            error: LogTestError(description: "boom")
        )
        #expect(suffix == " error=boom")
    }

    // MARK: - File handler emission shape

    @Test func `file log handler writes sorted metadata and error`() throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("somnio-log-emit-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        var handler = FileLogHandler(label: "test", fileName: "emit.log", directory: tmp,
                                     minimumLevel: { .trace })
        handler.metadata = ["zebra": "z"]

        handler.log(event: LogEvent(
            level: .info,
            message: "hello",
            error: LogTestError(description: "boom"),
            metadata: ["alpha": "a"],
            source: "test", file: #file, function: #function, line: #line
        ))

        let contents = try String(
            contentsOf: tmp.appendingPathComponent("emit.log"),
            encoding: .utf8
        )
        #expect(contents.contains("[INFO] [test] hello alpha=a zebra=z error=boom"))
    }
}
