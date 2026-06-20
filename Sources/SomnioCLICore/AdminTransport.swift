import Foundation
import HTTPTypes
import HummingbirdWSClient
import Logging
import NIOCore
import NIOFoundationCompat
import NIOSSL
import SomnioCore
import SomnioProtocol
import Synchronization

/// Transport-level failures from `AdminTransport.send`. The encode/decode/connect cases
/// carry the underlying typed `Error` (not a flattened `String`) so callers keep the
/// failure's type, `localizedDescription`, and downstream `as?` branching. Carrying a
/// typed `Error` drops `Equatable`, mirroring `GameplayTransportEvent`.
public enum AdminTransportError: Error, Sendable {
    case noResponse
    case unexpectedBinaryFrame
    case encodeFailed(Error)
    case decodeFailed(Error)
    case connectFailed(Error)
    case invalidTransportURL(SecureTransportValidationError)
    /// The release build's pinned trust root failed to load. `send` refuses to fall back
    /// to the system trust store, mirroring `GameplayTransportError.pinningRefused`.
    case pinningRefused(reason: String)
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
/// connection, writes the encoded `AdminRequest` as a JSON text frame, reads the first
/// inbound text frame as an `AdminResponse`, then closes normally.
public enum AdminTransport {
    // swiftlint:disable:next function_body_length
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

        // `validate` parses `url` with Foundation, but the dialer hands the unmodified
        // string to swift-websocket's own URI parser. Confirm both see the same host
        // before dialing — otherwise a percent-encoded/IDN host could pass `validate`
        // yet be dialed elsewhere. Returns the original string unchanged on agreement.
        let dialURL = try dialableURL(url)

        let frame: Data
        do {
            frame = try JSONEncoder().encode(request)
        } catch {
            throw AdminTransportError.encodeFailed(error)
        }

        let tlsConfiguration = try resolveTLS(AdminServerTrust.resolve(), logger: logger)

        var configuration = WebSocketClientConfiguration()
        configuration.maxFrameSize = SomnioProtocolConstants.maxWireFrameSize
        configuration.additionalHeaders[.authorization] = "Bearer \(token)"

        let box = ResponseBox()
        do {
            _ = try await WebSocketClient.connect(
                url: dialURL,
                configuration: configuration,
                tlsConfiguration: tlsConfiguration,
                logger: logger
            ) { inbound, outbound, _ in
                try await outbound.write(.text(String(decoding: frame, as: UTF8.self)))
                for try await message in inbound.messages(maxSize: SomnioProtocolConstants.maxWireFrameSize) {
                    switch message {
                    case let .text(string):
                        let response: AdminResponse
                        do {
                            response = try JSONDecoder().decode(AdminResponse.self, from: Data(string.utf8))
                        } catch {
                            try? await outbound.close(.protocolError, reason: "decode failed")
                            throw AdminTransportError.decodeFailed(error)
                        }
                        box.set(response)
                        // `try?` so a peer-initiated close racing the normal-close write
                        // doesn't mislabel a successful response as `decodeFailed`. The
                        // response is already in `box`; the close frame is best-effort.
                        try? await outbound.close(.normalClosure, reason: nil)
                        return
                    case .binary:
                        try? await outbound.close(.protocolError, reason: "unexpected binary frame")
                        throw AdminTransportError.unexpectedBinaryFrame
                    }
                }
            }
        } catch let error as AdminTransportError {
            throw error
        } catch {
            throw AdminTransportError.connectFailed(error)
        }

        guard let response = box.take() else {
            throw AdminTransportError.noResponse
        }
        return response
    }

    /// Maps an `AdminServerTrust.Resolution` to the TLS configuration the dial uses.
    /// Debug builds skip pinning (`nil`, so loopback `ws://` and the test suite are
    /// unaffected); release builds return the pinned config or fail closed with
    /// `.pinningRefused` rather than silently downgrading to system trust. Takes the
    /// resolution as a parameter so the fail-closed mapping is unit-testable without a
    /// release build.
    static func resolveTLS(_ resolution: AdminServerTrust.Resolution, logger: Logger) throws -> TLSConfiguration? {
        switch resolution {
        case .skipPinning:
            return nil
        case let .pinned(configuration):
            return configuration
        case let .refused(reason):
            logger.error("refusing to connect — production pin not loadable", metadata: ["reason": "\(reason)"])
            throw AdminTransportError.pinningRefused(reason: reason)
        }
    }

    /// Confirms via `SecureTransportValidator.validateHostAgreement` that the swift-websocket
    /// dialer will see the same host the validator validated, then returns the original `url`
    /// for dialing — no reconstruction, so query, port, and path survive. Fails closed on any
    /// parser disagreement.
    static func dialableURL(_ url: String) throws -> String {
        do {
            try SecureTransportValidator.validateHostAgreement(url)
        } catch let error as SecureTransportValidationError {
            throw AdminTransportError.invalidTransportURL(error)
        }
        return url
    }
}
