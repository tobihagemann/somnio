import Foundation
import Testing
@testable import SomnioCore

// Negative-input tests for `MapCodec.read` / `MapCodec.write`. The codec parses untrusted
// binary on the editor and server load paths, so every error case it throws should have
// at least one regression guard here.

struct MapCodecErrorTests {
    private func record(type: Int, payload: [UInt8]) -> [UInt8] {
        let length = payload.count + 2
        var out: [UInt8] = []
        out.append(UInt8(length & 0xFF))
        out.append(UInt8((length >> 8) & 0xFF))
        out.append(UInt8(type & 0xFF))
        out.append(UInt8((type >> 8) & 0xFF))
        out.append(contentsOf: payload)
        return out
    }

    @Test func `truncated header`() {
        // One byte — not enough for a u16 record-length prefix.
        let bytes = Data([0x01])
        #expect(throws: MapCodecError.truncated) { try MapCodec.read(bytes) }
    }

    @Test func `length less than two`() {
        // length=1 means the record claims to be smaller than its own type-id field.
        let bytes = Data([0x01, 0x00, 0x00, 0x00])
        #expect(throws: MapCodecError.truncated) { try MapCodec.read(bytes) }
    }

    @Test func `payload runs past EOF`() {
        // length=10 (8 bytes payload), only 4 payload bytes provided.
        let bytes = Data([0x0A, 0x00, 0x02, 0x00, 0xAA, 0xBB, 0xCC, 0xDD])
        #expect(throws: MapCodecError.truncatedRecord(typeID: 2)) { try MapCodec.read(bytes) }
    }

    @Test func `unknown record type`() {
        // type=99 is not a defined RecordType.
        let bytes = Data(record(type: 99, payload: [0x00, 0x00]))
        #expect(throws: MapCodecError.unknownRecordType(99)) { try MapCodec.read(bytes) }
    }

    @Test func `unsupported NPC discriminator`() {
        // npcOrMonsterSpawn record (type 5) with discriminator=2 (only 0/1 are valid).
        var payload: [UInt8] = []
        for _ in 0 ..< 6 {
            payload.append(0x00); payload.append(0x00)
        } // 6 × Int16 zeros
        payload.append(0x02); payload.append(0x00) // discriminator = 2
        payload.append(0x00) // PString length = 0
        let bytes = Data(record(type: 5, payload: payload))
        #expect(throws: MapCodecError.unsupportedDiscriminator(2)) { try MapCodec.read(bytes) }
    }

    @Test func `unknown portal direction`() {
        // sectorPortal (type 4) with direction raw = 99 — not a valid PortalDirection case.
        var payload: [UInt8] = [
            0, 0, 0, 0, 0, 0, 0, 0, // x, y, width, height
            0, // PString length 0
            0x63, 0x00 // direction = 99
        ]
        payload = Array(record(type: 4, payload: payload))
        #expect(throws: MapCodecError.unknownPortalDirection(99)) { try MapCodec.read(Data(payload)) }
    }

    @Test func `trailing bytes in record`() {
        // version record (type 0) declares 4 payload bytes but only consumes 2 (one Int16).
        let bytes = Data(record(type: 0, payload: [0x01, 0x00, 0xFF, 0xFF]))
        #expect(throws: MapCodecError.trailingBytesInRecord(typeID: 0, remaining: 2)) {
            try MapCodec.read(bytes)
        }
    }

    @Test func `invalid PString UTF-8`() {
        // npcOrMonsterSpawn with a PString name whose bytes are not valid UTF-8.
        var payload: [UInt8] = []
        for _ in 0 ..< 6 {
            payload.append(0x00); payload.append(0x00)
        }
        payload.append(0x00); payload.append(0x00) // discriminator = 0 (NPC)
        payload.append(0x02) // PString length 2
        payload.append(0xC3); payload.append(0x28) // invalid UTF-8 sequence
        // Pad rest of NPC fields so we don't trip truncation first.
        for _ in 0 ..< 3 {
            payload.append(0x00); payload.append(0x00)
        } // figure/direction/behavior
        payload.append(0x00) // dialogScript len 0
        let bytes = Data(record(type: 5, payload: payload))
        #expect(throws: MapCodecError.self) { try MapCodec.read(bytes) }
    }

    @Test func `PString write rejects over 255 bytes`() {
        let longName = String(repeating: "a", count: 256)
        let body = SectorBody(
            version: 1,
            dimensions: GridSize(width: 1, height: 1),
            ground: GroundTile(tilesetIndex: 0, sourceX: 0, sourceY: 0),
            light: LightSetting(indoor: false, brightness: 100),
            portals: [SectorPortal(x: 0, y: 0, width: 1, height: 1,
                                   targetSectorName: longName, direction: .outboundTrigger)]
        )
        #expect(throws: MapCodecError.self) { try MapCodec.write(body) }
    }
}
