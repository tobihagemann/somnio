import Foundation
import Testing
@testable import SomnioProtocol

/// The Swift half of the cross-language golden-frame invariant.
///
/// This is the only check in the repo that catches a **payload property rename**. The round-trip
/// suite cannot: it encodes and decodes with the same renamed property, so it stays green. The
/// browser client's own suite cannot either, because it mirrors only itself. Pinning the encoder's
/// output against a committed file, which the TypeScript side reads too, is what connects the two.
///
/// Regenerate deliberately with `SOMNIO_RECORD_GOLDEN_FRAMES=1 swift test --filter GoldenFrameTests`
/// and read the diff before committing — a surprising diff means the wire format moved.
struct GoldenFrameTests {
    private static let fixtureName = "golden-frames.json"

    @Test func `every message tag has a fixture`() {
        let names = Set(GoldenFrameCatalog.entries.map(\.name))
        // Tag coverage rather than entry count, so extra shape-coverage entries (a second `login`
        // with the optional field set) do not have to be double-counted.
        let coveredTags = Set(GoldenFrameCatalog.entries.map(\.message.tag))
        let missing = Set(SomnioMessageTag.allCases).subtracting(coveredTags)
        #expect(missing.isEmpty, "no golden frame for: \(missing.map(\.rawValue).sorted().joined(separator: ", "))")
        #expect(names.count == GoldenFrameCatalog.entries.count, "duplicate fixture name")
    }

    @Test func `encoder output matches the committed fixtures`() throws {
        let recorded = try recordedFixtures()
        if ProcessInfo.processInfo.environment["SOMNIO_RECORD_GOLDEN_FRAMES"] == "1" {
            try writeFixtures(recorded)
            Issue.record("golden frames re-recorded; review the diff and commit \(Self.fixtureName)")
            return
        }

        let committed = try loadCommittedFixtures()
        for entry in GoldenFrameCatalog.entries {
            let expected = try #require(
                committed[entry.name],
                "missing fixture \"\(entry.name)\" — re-record with SOMNIO_RECORD_GOLDEN_FRAMES=1"
            )
            let actual = try #require(recorded[entry.name])
            #expect(actual == expected, "golden frame \"\(entry.name)\" drifted:\nexpected\n\(expected)\ngot\n\(actual)")
        }
    }

    /// The fixtures must also decode back through the real decoder, so a fixture that drifted into
    /// a shape the decoder rejects fails here rather than silently only guarding the encoder.
    @Test func `committed fixtures decode through the real decoder`() throws {
        for (name, canonical) in try loadCommittedFixtures() {
            let data = Data(canonical.utf8)
            #expect(throws: Never.self, "fixture \"\(name)\" no longer decodes") {
                _ = try SomnioMessageDecoder.decode(data)
            }
        }
    }

    // MARK: - Fixture IO

    private func recordedFixtures() throws -> [String: String] {
        var canonical: [String: String] = [:]
        for entry in GoldenFrameCatalog.entries {
            let encoded = try SomnioMessageEncoder.encode(entry.message)
            canonical[entry.name] = try GoldenFrameCatalog.canonicalJSON(encoded)
        }
        return canonical
    }

    private func loadCommittedFixtures() throws -> [String: String] {
        let url = try #require(
            Bundle.module.url(forResource: Self.fixtureName, withExtension: nil, subdirectory: "GoldenFrames"),
            "\(Self.fixtureName) is not bundled; check the test target's resources"
        )
        let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: url))
        let container = try #require(raw as? [String: Any])
        var canonical: [String: String] = [:]
        for (name, frame) in container {
            let data = try JSONSerialization.data(withJSONObject: frame)
            canonical[name] = try GoldenFrameCatalog.canonicalJSON(data)
        }
        return canonical
    }

    /// Writes back to the **source** tree, not the copied bundle resource, so a re-record actually
    /// updates the committed file. `#filePath` is the only route to the source directory from a
    /// test; it is dev-only and gated behind the environment variable.
    private func writeFixtures(_ canonical: [String: String]) throws {
        var container: [String: Any] = [:]
        for (name, json) in canonical {
            container[name] = try JSONSerialization.jsonObject(with: Data(json.utf8))
        }
        let data = try JSONSerialization.data(
            withJSONObject: container,
            options: [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
        )
        let directory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("GoldenFrames", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try data.write(to: directory.appendingPathComponent(Self.fixtureName))
    }
}
