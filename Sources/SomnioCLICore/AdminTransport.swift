import Foundation
import HTTPTypes
import HummingbirdWSClient
import Logging
import NIOCore
import NIOFoundationCompat
import SomnioCore
import SomnioProtocol
import Synchronization

public enum AdminTransportError: Error, Sendable, Equatable {
    case noResponse
    case unexpectedTextFrame
    case encodeFailed(description: String)
    case decodeFailed(description: String)
    case connectFailed(description: String)
    case invalidTransportURL(SecureTransportValidationError)
}

/// Captures the single response frame the admin server sends back across the
/// `WebSocketClient.connect` handler boundary. The class wrapper is `Sendable` (the
/// `Mutex` provides the synchronization) so the `@Sendable` handler closure may capture
/// it by reference, and the outer scope reads `take()` after `connect` returns.
private final class ResponseBox: Sendable {
    private let storage = Mutex<AdminResponse?>(nil)

    func set(_ value: AdminResponse) {
        storage.withLock { $0 = value }
    }

    func take() -> AdminResponse? {
        storage.withLock { value in
            let captured = value
            value = nil
            return captured
        }
    }
}

/// Single-shot request/response over the `/admin` WebSocket. Opens an authenticated
/// connection, writes the encoded `AdminRequest`, reads the first inbound binary frame
/// as an `AdminResponse`, then closes normally.
public enum AdminTransport {
    public static func send(
        _ request: AdminRequest,
        to url: String,
        token: String,
        logger: Logger
    ) async throws -> AdminResponse {
        // Defense in depth against `ws://attacker@localhost/...` parser-disagreement attacks
        // and against an importer constructing an admin URL that would carry the bearer
        // token over plaintext to a remote host. The CLI's arg-parse layer validates the
        // same URL upstream; this gate protects every other public caller of `send`.
        do {
            try SecureTransportValidator.validate(url)
        } catch let error as SecureTransportValidationError {
            throw AdminTransportError.invalidTransportURL(error)
        }

        let frame: Data
        do {
            frame = try BinaryEncoder().encode(request)
        } catch {
            throw AdminTransportError.encodeFailed(description: "\(error)")
        }

        var configuration = WebSocketClientConfiguration()
        configuration.maxFrameSize = SomnioProtocolConstants.maxWireFrameSize
        configuration.additionalHeaders[.authorization] = "Bearer \(token)"

        let box = ResponseBox()
        do {
            _ = try await WebSocketClient.connect(
                url: url,
                configuration: configuration,
                logger: logger
            ) { inbound, outbound, _ in
                try await outbound.write(.binary(ByteBuffer(data: frame)))
                for try await message in inbound.messages(maxSize: SomnioProtocolConstants.maxWireFrameSize) {
                    switch message {
                    case let .binary(buffer):
                        let response: AdminResponse
                        do {
                            response = try BinaryDecoder().decode(AdminResponse.self, from: Data(buffer: buffer))
                        } catch {
                            try? await outbound.close(.protocolError, reason: "decode failed")
                            throw AdminTransportError.decodeFailed(description: "\(error)")
                        }
                        box.set(response)
                        // `try?` so a peer-initiated close racing the normal-close write
                        // doesn't mislabel a successful response as `decodeFailed`. The
                        // response is already in `box`; the close frame is best-effort.
                        try? await outbound.close(.normalClosure, reason: nil)
                        return
                    case .text:
                        try? await outbound.close(.protocolError, reason: "unexpected text frame")
                        throw AdminTransportError.unexpectedTextFrame
                    }
                }
            }
        } catch let error as AdminTransportError {
            throw error
        } catch {
            throw AdminTransportError.connectFailed(description: "\(error)")
        }

        guard let response = box.take() else {
            throw AdminTransportError.noResponse
        }
        return response
    }
}
