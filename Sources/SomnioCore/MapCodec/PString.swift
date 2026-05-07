import Foundation

/// Legacy `PString` helpers: a single-byte length prefix followed by `count` bytes of
/// UTF-8. Used by the sector binary format only — the wire protocol uses a different
/// (u16 LE) length-prefixed string convention.
enum PString {
    static func read(_ reader: inout BinaryReader, recordTypeID: Int) throws -> String {
        let length = try Int(reader.readUInt8())
        guard reader.offset + length <= reader.data.count else {
            throw MapCodecError.truncatedRecord(typeID: recordTypeID)
        }
        let bytes = try reader.readBytes(length)
        guard let s = String(data: bytes, encoding: .utf8) else {
            throw MapCodecError.invalidPString(at: reader.offset - length)
        }
        return s
    }

    static func write(_ writer: inout BinaryWriter, _ value: String) throws {
        let utf8 = Data(value.utf8)
        guard utf8.count <= Int(UInt8.max) else {
            throw MapCodecError.invalidPString(at: writer.data.count)
        }
        writer.writeUInt8(UInt8(utf8.count))
        writer.writeBytes(utf8)
    }
}
