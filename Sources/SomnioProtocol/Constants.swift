import Foundation

public enum SomnioProtocolConstants {
    public static let helloVersion: UInt16 = 1
    public static let maxFrameLength: UInt32 = 1 << 20

    /// UTF-8 byte cap for the `nickname` and `email` fields in `LoginMessage` /
    /// `RegisterMessage`. The server enforces this in `LoginHandler` /
    /// `RegisterHandler` (rejecting oversized inputs with `.badCredentials` /
    /// `.failure`); the client mirrors it in the login + registration sheets so
    /// the user gets in-form feedback before the round-trip.
    public static let maxIdentifierUTF8Bytes = 64

    /// UTF-8 byte cap for the `password` field in `LoginMessage` / `RegisterMessage`.
    /// Capping the inbound length is what keeps an unauthenticated frame from
    /// pipelining 64 KB password attempts that each pay full Argon2id verify cost.
    public static let maxPasswordUTF8Bytes = 128

    /// Total bytes of WebSocket framing overhead the wire format adds on top of the
    /// `[u8 tag][u32 LE payload_length][payload]` payload — one byte for the tag
    /// plus four bytes for the little-endian length. Every transport that sets a
    /// max-frame-size on its WebSocket configuration adds this constant to
    /// `maxFrameLength`.
    public static let frameHeaderBytes: Int = 5

    /// Convenience: the WebSocket-layer `maxFrameSize` every transport should ship.
    public static let maxWireFrameSize: Int = .init(maxFrameLength) + frameHeaderBytes
}

public enum SomnioProtocolError: Error, Equatable, Sendable {
    case truncated
    case invalidPayload(reason: String)
    case unrecognizedTag(UInt8)
    case oversizedFrame(UInt32)
}
