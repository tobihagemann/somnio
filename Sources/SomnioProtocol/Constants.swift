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

    /// Minimum UTF-8 byte floor for a registration password (NIST SP 800-63B §5.1.1.2
    /// baseline). Lives beside the caps so the server's `RegisterHandler` and the client's
    /// registration form read the same floor.
    public static let minPasswordUTF8Bytes = 8

    /// UTF-8 byte cap for `SayMessage` / `AdminSayMessage` text. A chat line renders in a
    /// 4-line speech bubble, so anything beyond a couple hundred bytes is never shown; the
    /// server enforces this on the inbound chat and admin-say paths so a single message
    /// cannot fan out a large payload to every peer in a sector.
    public static let maxSayUTF8Bytes = 256

    /// Slack the WebSocket-layer `maxFrameSize` keeps above the encoder's `maxFrameLength`
    /// guard. Holding `maxWireFrameSize` strictly larger than `maxFrameLength` means an
    /// oversized message throws `SomnioProtocolError.oversizedFrame` cleanly at encode time
    /// rather than the receiver hard-closing the connection on a `maxFrameSize` overrun. The
    /// value is an arbitrary cushion — any positive amount satisfies the strict-inequality
    /// invariant; with JSON text frames there is no fixed header to size it against.
    public static let frameSizeSlack: Int = 64

    /// Convenience: the WebSocket-layer `maxFrameSize` every transport should ship.
    public static let maxWireFrameSize: Int = .init(maxFrameLength) + frameSizeSlack
}

public enum SomnioProtocolError: Error, Equatable, Sendable {
    case unrecognizedTag(String)
    /// Emitted only by `SomnioMessageEncoder.encode` (outbound) when a message exceeds
    /// `maxFrameLength`; no decode path throws this.
    case oversizedFrame(UInt32)
}
