import Foundation
import Testing
@testable import SomnioProtocol

struct BinaryCoderTests {
    @Test func `empty string round trip`() throws {
        let m = SayMessage(entityIndex: 0, text: "")
        let bytes = try BinaryEncoder().encode(m)
        // entityIndex: 2 bytes; text length: 2 bytes; no payload.
        #expect(bytes.count == 4)
        let decoded = try BinaryDecoder().decode(SayMessage.self, from: bytes)
        #expect(decoded == m)
    }

    @Test func `multi field declaration order layout`() throws {
        let energy = Energy(
            hpCurrent: 0x0102, hpMax: 0x0304,
            balanceCurrent: 0x0506, balanceMax: 0x0708,
            manaCurrent: 0x090A, manaMax: 0x0B0C
        )
        let bytes = try BinaryEncoder().encode(energy)
        // 6 × Int16 LE = 12 bytes, in declaration order.
        let expected: [UInt8] = [
            0x02, 0x01, 0x04, 0x03, 0x06, 0x05,
            0x08, 0x07, 0x0A, 0x09, 0x0C, 0x0B
        ]
        #expect(Array(bytes) == expected)
    }

    @Test func `oversized frame rejection`() throws {
        // Build a synthetic frame whose payload_length exceeds maxFrameLength.
        var frame = Data()
        frame.append(SomnioMessageTag.hello.rawValue)
        let oversized = SomnioProtocolConstants.maxFrameLength + 1
        frame.append(UInt8(oversized & 0xFF))
        frame.append(UInt8((oversized >> 8) & 0xFF))
        frame.append(UInt8((oversized >> 16) & 0xFF))
        frame.append(UInt8((oversized >> 24) & 0xFF))
        #expect(throws: SomnioProtocolError.oversizedFrame(oversized)) {
            try SomnioMessageDecoder.decode(frame)
        }
    }

    @Test func `truncated input rejection`() throws {
        // Frame header claims 100 bytes of payload but only 4 are provided.
        var frame = Data()
        frame.append(SomnioMessageTag.hello.rawValue)
        frame.append(UInt8(100)); frame.append(0); frame.append(0); frame.append(0)
        frame.append(0); frame.append(0); frame.append(0); frame.append(0)
        #expect(throws: SomnioProtocolError.truncated) {
            try SomnioMessageDecoder.decode(frame)
        }
    }

    @Test func `unrecognized tag rejection`() throws {
        var frame = Data()
        frame.append(0xFF) // not a valid tag
        frame.append(0); frame.append(0); frame.append(0); frame.append(0)
        #expect(throws: SomnioProtocolError.unrecognizedTag(0xFF)) {
            try SomnioMessageDecoder.decode(frame)
        }
    }

    @Test func `header too short rejection`() throws {
        let frame = Data([0x10, 0x00, 0x00]) // 3 bytes, header needs 5
        #expect(throws: SomnioProtocolError.truncated) {
            try SomnioMessageDecoder.decode(frame)
        }
    }

    @Test func `array count is U int 16 prefix`() throws {
        let inv = InventoryMessage(rows: [
            WireInventoryRow(slot: 0, category: 0, itemId: 0, extras: [], equippedHand: .none),
            WireInventoryRow(slot: 1, category: 1, itemId: 7, extras: [WireInventoryExtra(key: "gold", value: 50)], equippedHand: .right),
            WireInventoryRow(slot: 2, category: 2, itemId: 8, extras: [], equippedHand: .left)
        ])
        let bytes = try BinaryEncoder().encode(inv)
        // First two bytes are u16 LE row count = 3.
        #expect(bytes[bytes.startIndex] == 3)
        #expect(bytes[bytes.startIndex + 1] == 0)
    }

    @Test func `string at u16 max length round trips`() throws {
        let big = String(repeating: "a", count: Int(UInt16.max))
        let m = SayMessage(entityIndex: 0, text: big)
        let bytes = try BinaryEncoder().encode(m)
        let decoded = try BinaryDecoder().decode(SayMessage.self, from: bytes)
        #expect(decoded == m)
    }

    @Test func `string above u16 max rejected`() {
        let tooLong = String(repeating: "a", count: Int(UInt16.max) + 1)
        let m = SayMessage(entityIndex: 0, text: tooLong)
        #expect(throws: SomnioProtocolError.self) {
            try BinaryEncoder().encode(m)
        }
    }

    @Test func `truncated string payload rejected`() {
        // entityIndex (2 bytes) + claimed length 10 (2 bytes) + only 3 actual UTF-8 bytes.
        let bytes = Data([0, 0, 0x0A, 0x00, 0x68, 0x69, 0x21])
        #expect(throws: SomnioProtocolError.truncated) {
            try BinaryDecoder().decode(SayMessage.self, from: bytes)
        }
    }

    @Test func `invalid UTF-8 string rejected`() {
        // entityIndex (2 bytes) + length 2 + invalid UTF-8 sequence.
        let bytes = Data([0, 0, 0x02, 0x00, 0xC3, 0x28])
        #expect(throws: SomnioProtocolError.self) {
            try BinaryDecoder().decode(SayMessage.self, from: bytes)
        }
    }

    @Test func `trailing bytes past payload rejected`() {
        // entityIndex (2 bytes) + length 0 (2 bytes) + 4 unexpected trailing bytes.
        let bytes = Data([0, 0, 0x00, 0x00, 0xDE, 0xAD, 0xBE, 0xEF])
        #expect(throws: SomnioProtocolError.self) {
            try BinaryDecoder().decode(SayMessage.self, from: bytes)
        }
    }

    @Test func `frame trailing bytes past payload rejected`() {
        // [u8 tag=hello][u32 LE payload_length=2][hello payload=2 bytes][2 stray trailing bytes]
        var frame = Data()
        frame.append(SomnioMessageTag.hello.rawValue)
        frame.append(UInt8(2)); frame.append(0); frame.append(0); frame.append(0)
        frame.append(0x01); frame.append(0x00) // protocolVersion = 1
        frame.append(0xFF); frame.append(0xFF) // stray trailing bytes
        #expect(throws: SomnioProtocolError.self) {
            try SomnioMessageDecoder.decode(frame)
        }
    }
}
