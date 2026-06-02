import Foundation
import HummingbirdWebSocket
import Logging
import NIOCore
import NIOFoundationCompat
import SomnioProtocol

/// Single-shot frame writer for the admin connection. The admin protocol is
/// request/response with no broadcast fan-out, so the per-connection `ConnectionOutbox`
/// machinery is unnecessary — the response is written inline as a JSON text frame.
/// Non-throwing: a `JSONEncoder` failure is unreachable for these string-only payloads,
/// and an `outbound.write` failure means the peer has already disconnected (no useful
/// recovery distinct from "log and continue").
enum AdminFrameWriter {
    static func write(
        _ response: AdminResponse,
        to outbound: WebSocketOutboundWriter,
        logger: Logger
    ) async {
        do {
            let frame = try JSONEncoder().encode(response)
            try await outbound.write(.text(String(decoding: frame, as: UTF8.self)))
        } catch {
            // Log the case name only — never the full `\(response)`. Payload-bearing
            // variants like `.logContents`/`.weblogContents` can carry up to ~65 KB of
            // log text; including them in operator-visible warnings would copy log
            // contents into stdout and `admin-log.log` whenever a peer disconnects mid
            // write.
            logger.warning(
                "admin response write failed",
                metadata: ["error": "\(error)", "case": "\(adminResponseCaseName(response))"]
            )
        }
    }

    private static func adminResponseCaseName(_ response: AdminResponse) -> String {
        switch response {
        case .logContents: "logContents"
        case .weblogContents: "weblogContents"
        case .logEmpty: "logEmpty"
        case .logRemoved: "logRemoved"
        case .weblogEmpty: "weblogEmpty"
        case .weblogRemoved: "weblogRemoved"
        case .playerCount: "playerCount"
        case .worldClock: "worldClock"
        case .sayBroadcast: "sayBroadcast"
        case .kickedPlayer: "kickedPlayer"
        case .kickedPlayerNotFound: "kickedPlayerNotFound"
        case .versionString: "versionString"
        case .unknownCommand: "unknownCommand"
        }
    }
}
