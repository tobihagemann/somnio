import Foundation
import Logging

/// A swift-log `LogHandler` that emits one JSON object per line to stdout. Used by the
/// server for container-friendly structured logging. Pure-Swift; no `os` dependency, so it
/// compiles on Linux. Each emitted object has the shape:
///
///     {"ts":"...","level":"info","label":"...","message":"...","metadata":{...}}
public struct JSONLogHandler: LogHandler {
    private let label: String

    public var logLevel: Logger.Level = .trace
    public var metadata: Logger.Metadata = [:]
    public var metadataProvider: Logger.MetadataProvider?

    public init(label: String) {
        self.label = label
    }

    public func log(event: LogEvent) {
        let timestamp = Date.now.formatted(Self.timestampStyle)
        let merged = LogMetadata.merged(
            handler: metadata,
            provider: metadataProvider?.get(),
            event: event.metadata
        )

        var json = "{"
        json += "\"ts\":\"\(Self.escape(timestamp))\","
        json += "\"level\":\"\(Self.escape(event.level.rawValue))\","
        json += "\"label\":\"\(Self.escape(label))\","
        json += "\"message\":\"\(Self.escape(event.message.description))\""
        if let error = event.error {
            json += ",\"error\":\"\(Self.escape(String(describing: error)))\""
        }
        if !merged.isEmpty {
            json += ",\"metadata\":{"
            let entries = merged.sorted(by: { $0.key < $1.key }).map { key, value in
                "\"\(Self.escape(key))\":\"\(Self.escape("\(value)"))\""
            }
            json += entries.joined(separator: ",")
            json += "}"
        }
        json += "}\n"

        // `FileHandle.write` is not atomic for arbitrary-sized payloads — concurrent emitters
        // would let JSON objects interleave on stdout, breaking the "one object per line"
        // contract. Serialize across all `JSONLogHandler` instances via a process-wide lock.
        Self.stdoutLock.lock()
        defer { Self.stdoutLock.unlock() }
        try? FileHandle.standardOutput.write(contentsOf: Data(json.utf8))
    }

    public subscript(metadataKey key: String) -> Logger.Metadata.Value? {
        get { metadata[key] }
        set { metadata[key] = newValue }
    }

    private static let timestampStyle = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let stdoutLock = NSLock()

    static func escape(_ s: String) -> String {
        var out = ""
        out.reserveCapacity(s.count)
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out
    }
}
