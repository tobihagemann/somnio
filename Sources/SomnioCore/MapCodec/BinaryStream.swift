import Foundation

/// Read-side stream over a `Data` buffer with little-endian integer reads. Sibling of
/// `SomnioProtocol`'s reader — duplicated to keep `SomnioCore` Foundation-only and protocol-
/// independent (the file format and the wire protocol use different framing rules).
struct BinaryReader {
    let data: Data
    private(set) var offset: Int = 0

    init(_ data: Data) {
        self.data = data
    }

    var isAtEnd: Bool {
        offset >= data.count
    }

    mutating func readUInt8() throws -> UInt8 {
        guard offset < data.count else { throw MapCodecError.truncated }
        let byte = data[data.startIndex + offset]
        offset += 1
        return byte
    }

    mutating func readUInt16LE() throws -> UInt16 {
        guard offset + 2 <= data.count else { throw MapCodecError.truncated }
        let lo = UInt16(data[data.startIndex + offset])
        let hi = UInt16(data[data.startIndex + offset + 1])
        offset += 2
        return (hi << 8) | lo
    }

    mutating func readInt16LE() throws -> Int16 {
        try Int16(bitPattern: readUInt16LE())
    }

    mutating func readBytes(_ count: Int) throws -> Data {
        guard offset + count <= data.count else { throw MapCodecError.truncated }
        let range = (data.startIndex + offset) ..< (data.startIndex + offset + count)
        let slice = data[range]
        offset += count
        return slice
    }
}

/// Write-side buffer with little-endian integer writes.
struct BinaryWriter {
    private(set) var data = Data()

    mutating func writeUInt8(_ value: UInt8) {
        data.append(value)
    }

    mutating func writeUInt16LE(_ value: UInt16) {
        data.append(UInt8(value & 0xFF))
        data.append(UInt8((value >> 8) & 0xFF))
    }

    mutating func writeInt16LE(_ value: Int16) {
        writeUInt16LE(UInt16(bitPattern: value))
    }

    mutating func writeBytes(_ bytes: Data) {
        data.append(bytes)
    }
}
