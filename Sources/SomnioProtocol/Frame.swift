import Foundation

/// Tag byte that identifies which `SomnioMessage` variant is in a frame. Tag values are
/// fixed and load-bearing: server and client must agree on the tag→payload mapping.
///
/// Frame wire format: `[u8 tag][u32 LE payload_length][payload]`. The `u32 LE payload_length`
/// is defensive — inside a WebSocket binary frame the message boundary is already provided
/// by the transport, but the inner length lets the decoder validate against a payload-length
/// value independent of WebSocket framing, so a transport-layer truncation bug still trips a
/// decode error rather than being silently accepted as a short frame.
public enum SomnioMessageTag: UInt8, CaseIterable, Sendable, Equatable {
    // C→S
    case login = 0x01
    case register = 0x02
    case clientPosition = 0x03
    case clientSay = 0x04
    case equipToggle = 0x05
    case bumpNPC = 0x06
    case enterPortal = 0x07

    // S→C
    case hello = 0x10
    case loginResult = 0x11
    case registerResult = 0x12
    case enterSector = 0x13
    case mainCharacter = 0x14
    case entity = 0x15
    case serverPosition = 0x16
    case serverSay = 0x17
    case energy = 0x18
    case dateTick = 0x19
    case inventory = 0x1A
    case leave = 0x1B
    case adminSay = 0x1C
}
