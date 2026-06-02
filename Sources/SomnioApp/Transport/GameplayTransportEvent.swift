import Foundation
import SomnioProtocol

/// Discriminated event the transport hands to its delegate. `SomnioMessage` covers the
/// happy path; the remaining cases drive the chat-line / disconnect handling on the
/// view-model side. The wire enum is closed, so transport-only failure paths cannot be
/// modelled as a synthetic `SomnioMessage` case — they live here instead.
public enum GameplayTransportEvent: Sendable {
    case message(SomnioMessage)
    case connectFailed(Error)
    case decodeFailed(Error)
    case unexpectedBinaryFrame
    case peerEOF
}

/// Receives transport-level events on `@MainActor`. The view model conforms.
@MainActor public protocol GameplayTransportDelegate: AnyObject, Sendable {
    func handle(_ event: GameplayTransportEvent)
}

/// Transport-level failures raised before a socket is even attempted.
public enum GameplayTransportError: Error, Sendable, Equatable {
    /// The release build's pinned trust root failed to load. The transport refuses
    /// to fall back to the system trust store; the user sees `.connectFailed`.
    case pinningRefused(reason: String)
}
