import Foundation
import HummingbirdWebSocket
import NIOWebSocket

/// The outbound half of a gameplay WebSocket, narrowed to the two operations
/// `ConnectionActor` performs: write a JSON text frame and close. Extracting this seam lets
/// the drain-before-close exit ordering be driven by a recording test spy without standing up
/// a live socket; production keeps static dispatch via the generic helpers that consume it.
protocol ConnectionOutboundSink: Sendable {
    func writeText(_ data: Data) async throws
    func close(code: WebSocketErrorCode, reason: String) async
}

/// Concrete adapter wrapping the real `WebSocketOutboundWriter`. `writeText` mirrors the
/// former inline `outbound.write(.text(...))`; `close` swallows the throw exactly as the
/// former `try? await outbound.close(...)` did (the connection is already tearing down).
struct WebSocketOutboundSink: ConnectionOutboundSink {
    let outbound: WebSocketOutboundWriter

    func writeText(_ data: Data) async throws {
        try await outbound.write(.text(String(decoding: data, as: UTF8.self)))
    }

    func close(code: WebSocketErrorCode, reason: String) async {
        try? await outbound.close(code, reason: reason)
    }
}
