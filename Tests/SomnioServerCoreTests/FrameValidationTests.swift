import Foundation
import SomnioProtocol
import Testing

/// Crafted-byte coverage for the `SomnioMessageDecoder` failure modes the connection actor's
/// terminal-close path catches. Each test asserts the exact error case so a future change to
/// the decoder can't silently widen the close path.
struct FrameValidationTests {
    @Test func `single-byte input is shorter than the 5-byte header`() {
        let bytes = Data([0x01])
        #expect(throws: SomnioProtocolError.truncated) {
            _ = try SomnioMessageDecoder.decode(bytes)
        }
    }

    @Test func `unrecognized tag surfaces unrecognizedTag with the offending byte`() {
        let bytes = Data([0xFF, 0, 0, 0, 0])
        #expect(throws: SomnioProtocolError.unrecognizedTag(0xFF)) {
            _ = try SomnioMessageDecoder.decode(bytes)
        }
    }

    @Test func `payload length strictly greater than maxFrameLength surfaces oversizedFrame`() {
        // tag = login (0x01), payload length = (1 << 20) + 1 = 0x00100001 LE
        let bytes = Data([0x01, 0x01, 0x00, 0x10, 0x00])
        #expect(throws: SomnioProtocolError.oversizedFrame((1 << 20) + 1)) {
            _ = try SomnioMessageDecoder.decode(bytes)
        }
    }

    @Test func `trailing bytes past advertised payload length surface invalidPayload`() throws {
        // Encode a real LoginMessage, then bump the advertised payload length down by 2 so the
        // outer "trailing-byte gate" fires.
        let login = SomnioMessage.login(LoginMessage(nickname: "alice", password: "secret"))
        var frame = try SomnioMessageEncoder.encode(login)
        // Subtract 2 from the LE u32 length at offset 1..<5 so the inner payload still parses
        // but the outer end-of-frame check rejects two trailing bytes.
        let originalLength = UInt32(frame[1]) | (UInt32(frame[2]) << 8) | (UInt32(frame[3]) << 16) | (UInt32(frame[4]) << 24)
        let truncatedLength = originalLength - 2
        frame[1] = UInt8(truncatedLength & 0xFF)
        frame[2] = UInt8((truncatedLength >> 8) & 0xFF)
        frame[3] = UInt8((truncatedLength >> 16) & 0xFF)
        frame[4] = UInt8((truncatedLength >> 24) & 0xFF)
        do {
            _ = try SomnioMessageDecoder.decode(frame)
            Issue.record("expected SomnioProtocolError.invalidPayload")
        } catch let SomnioProtocolError.invalidPayload(reason) {
            #expect(reason.contains("trailing"))
        }
    }

    @Test func `payload shorter than advertised surfaces truncated`() throws {
        // Encode a real LoginMessage, then bump the advertised payload length up by 2 so the
        // outer payloadEnd <= data.endIndex check fires.
        let login = SomnioMessage.login(LoginMessage(nickname: "bob", password: "another"))
        var frame = try SomnioMessageEncoder.encode(login)
        let originalLength = UInt32(frame[1]) | (UInt32(frame[2]) << 8) | (UInt32(frame[3]) << 16) | (UInt32(frame[4]) << 24)
        let extendedLength = originalLength + 2
        frame[1] = UInt8(extendedLength & 0xFF)
        frame[2] = UInt8((extendedLength >> 8) & 0xFF)
        frame[3] = UInt8((extendedLength >> 16) & 0xFF)
        frame[4] = UInt8((extendedLength >> 24) & 0xFF)
        #expect(throws: SomnioProtocolError.truncated) {
            _ = try SomnioMessageDecoder.decode(frame)
        }
    }
}
