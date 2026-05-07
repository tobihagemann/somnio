import Foundation

/// Project-defined binary `Encoder` for the wire protocol.
///
/// Container model is positional, not key-named: keyed containers walk fields in `CodingKeys`
/// declaration order regardless of the key string. Primitives serialize as little-endian:
/// `Int16` / `Int32` / `UInt16` / `UInt32` LE, `Bool` as `u8`, `String` as `u16 LE length` +
/// UTF-8, arrays as `u16 LE count` + element-wise.
public final class BinaryEncoder: Encoder {
    public var codingPath: [CodingKey] = []
    public var userInfo: [CodingUserInfoKey: Any] = [:]

    var buffer = Data()

    public init() {}

    public func encode(_ value: some Encodable) throws -> Data {
        buffer = Data()
        try value.encode(to: self)
        return buffer
    }

    public func container<Key: CodingKey>(keyedBy type: Key.Type) -> KeyedEncodingContainer<Key> {
        KeyedEncodingContainer(BinaryKeyedEncodingContainer<Key>(encoder: self))
    }

    public func unkeyedContainer() -> UnkeyedEncodingContainer {
        BinaryUnkeyedEncodingContainer(encoder: self)
    }

    public func singleValueContainer() -> SingleValueEncodingContainer {
        BinarySingleValueEncodingContainer(encoder: self)
    }

    // MARK: - Primitive writes

    func writeUInt8(_ value: UInt8) {
        buffer.append(value)
    }

    func writeUInt16LE(_ value: UInt16) {
        buffer.append(UInt8(value & 0xFF))
        buffer.append(UInt8((value >> 8) & 0xFF))
    }

    func writeUInt32LE(_ value: UInt32) {
        buffer.append(UInt8(value & 0xFF))
        buffer.append(UInt8((value >> 8) & 0xFF))
        buffer.append(UInt8((value >> 16) & 0xFF))
        buffer.append(UInt8((value >> 24) & 0xFF))
    }

    func writeInt16LE(_ value: Int16) {
        writeUInt16LE(UInt16(bitPattern: value))
    }

    func writeInt32LE(_ value: Int32) {
        writeUInt32LE(UInt32(bitPattern: value))
    }

    func writeBool(_ value: Bool) {
        writeUInt8(value ? 1 : 0)
    }

    func writeString(_ value: String) throws {
        let utf8 = Data(value.utf8)
        guard utf8.count <= Int(UInt16.max) else {
            throw SomnioProtocolError.invalidPayload(reason: "string length \(utf8.count) exceeds UInt16.max")
        }
        writeUInt16LE(UInt16(utf8.count))
        buffer.append(utf8)
    }

    /// Writes a `u16 LE` placeholder and returns the offset at which the count must be patched.
    func writeUInt16LEPlaceholder() -> Int {
        let offset = buffer.count
        buffer.append(0)
        buffer.append(0)
        return offset
    }

    func patchUInt16LE(at offset: Int, value: UInt16) {
        buffer[offset] = UInt8(value & 0xFF)
        buffer[offset + 1] = UInt8((value >> 8) & 0xFF)
    }
}

// MARK: - Keyed container

private struct BinaryKeyedEncodingContainer<Key: CodingKey>: KeyedEncodingContainerProtocol {
    let encoder: BinaryEncoder
    var codingPath: [CodingKey] {
        encoder.codingPath
    }

    mutating func encodeNil(forKey key: Key) throws {
        throw SomnioProtocolError.invalidPayload(reason: "nil values are not supported on the wire")
    }

    mutating func encode(_ value: Bool, forKey key: Key) throws {
        encoder.writeBool(value)
    }

    mutating func encode(_ value: String, forKey key: Key) throws {
        try encoder.writeString(value)
    }

    mutating func encode(_ value: Double, forKey key: Key) throws {
        throw SomnioProtocolError.invalidPayload(reason: "Double is not supported on the wire")
    }

    mutating func encode(_ value: Float, forKey key: Key) throws {
        throw SomnioProtocolError.invalidPayload(reason: "Float is not supported on the wire")
    }

    mutating func encode(_ value: Int, forKey key: Key) throws {
        throw SomnioProtocolError.invalidPayload(reason: "Int has variable platform width; use Int16/Int32")
    }

    mutating func encode(_ value: Int8, forKey key: Key) throws {
        encoder.writeUInt8(UInt8(bitPattern: value))
    }

    mutating func encode(_ value: Int16, forKey key: Key) throws {
        encoder.writeInt16LE(value)
    }

    mutating func encode(_ value: Int32, forKey key: Key) throws {
        encoder.writeInt32LE(value)
    }

    mutating func encode(_ value: Int64, forKey key: Key) throws {
        throw SomnioProtocolError.invalidPayload(reason: "Int64 is not supported on the wire")
    }

    mutating func encode(_ value: UInt, forKey key: Key) throws {
        throw SomnioProtocolError.invalidPayload(reason: "UInt has variable platform width; use UInt16/UInt32")
    }

    mutating func encode(_ value: UInt8, forKey key: Key) throws {
        encoder.writeUInt8(value)
    }

    mutating func encode(_ value: UInt16, forKey key: Key) throws {
        encoder.writeUInt16LE(value)
    }

    mutating func encode(_ value: UInt32, forKey key: Key) throws {
        encoder.writeUInt32LE(value)
    }

    mutating func encode(_ value: UInt64, forKey key: Key) throws {
        throw SomnioProtocolError.invalidPayload(reason: "UInt64 is not supported on the wire")
    }

    mutating func encode(_ value: some Encodable, forKey key: Key) throws {
        try value.encode(to: encoder)
    }

    mutating func nestedContainer<NestedKey: CodingKey>(keyedBy keyType: NestedKey.Type, forKey key: Key) -> KeyedEncodingContainer<NestedKey> {
        encoder.container(keyedBy: keyType)
    }

    mutating func nestedUnkeyedContainer(forKey key: Key) -> UnkeyedEncodingContainer {
        encoder.unkeyedContainer()
    }

    mutating func superEncoder() -> Encoder {
        encoder
    }

    mutating func superEncoder(forKey key: Key) -> Encoder {
        encoder
    }
}

// MARK: - Unkeyed container (arrays)

private struct BinaryUnkeyedEncodingContainer: UnkeyedEncodingContainer {
    let encoder: BinaryEncoder
    var codingPath: [CodingKey] {
        encoder.codingPath
    }

    var count: Int = 0
    let countOffset: Int

    init(encoder: BinaryEncoder) {
        self.encoder = encoder
        self.countOffset = encoder.writeUInt16LEPlaceholder()
    }

    mutating func encodeNil() throws {
        throw SomnioProtocolError.invalidPayload(reason: "nil values are not supported on the wire")
    }

    mutating func encode(_ value: Bool) throws {
        encoder.writeBool(value); try incr()
    }

    mutating func encode(_ value: String) throws {
        try encoder.writeString(value); try incr()
    }

    mutating func encode(_ value: Int16) throws {
        encoder.writeInt16LE(value); try incr()
    }

    mutating func encode(_ value: Int32) throws {
        encoder.writeInt32LE(value); try incr()
    }

    mutating func encode(_ value: UInt8) throws {
        encoder.writeUInt8(value); try incr()
    }

    mutating func encode(_ value: UInt16) throws {
        encoder.writeUInt16LE(value); try incr()
    }

    mutating func encode(_ value: UInt32) throws {
        encoder.writeUInt32LE(value); try incr()
    }

    mutating func encode(_ value: some Encodable) throws {
        try value.encode(to: encoder)
        try incr()
    }

    private mutating func incr() throws {
        count += 1
        guard count <= Int(UInt16.max) else {
            throw SomnioProtocolError.invalidPayload(reason: "array length \(count) exceeds UInt16.max")
        }
        encoder.patchUInt16LE(at: countOffset, value: UInt16(count))
    }

    mutating func nestedContainer<NestedKey: CodingKey>(keyedBy keyType: NestedKey.Type) -> KeyedEncodingContainer<NestedKey> {
        encoder.container(keyedBy: keyType)
    }

    mutating func nestedUnkeyedContainer() -> UnkeyedEncodingContainer {
        encoder.unkeyedContainer()
    }

    mutating func superEncoder() -> Encoder {
        encoder
    }
}

// MARK: - Single-value container

private struct BinarySingleValueEncodingContainer: SingleValueEncodingContainer {
    let encoder: BinaryEncoder
    var codingPath: [CodingKey] {
        encoder.codingPath
    }

    mutating func encodeNil() throws {
        throw SomnioProtocolError.invalidPayload(reason: "nil values are not supported on the wire")
    }

    mutating func encode(_ value: Bool) throws {
        encoder.writeBool(value)
    }

    mutating func encode(_ value: String) throws {
        try encoder.writeString(value)
    }

    mutating func encode(_ value: Int16) throws {
        encoder.writeInt16LE(value)
    }

    mutating func encode(_ value: Int32) throws {
        encoder.writeInt32LE(value)
    }

    mutating func encode(_ value: UInt8) throws {
        encoder.writeUInt8(value)
    }

    mutating func encode(_ value: UInt16) throws {
        encoder.writeUInt16LE(value)
    }

    mutating func encode(_ value: UInt32) throws {
        encoder.writeUInt32LE(value)
    }

    mutating func encode(_ value: Double) throws {
        throw SomnioProtocolError.invalidPayload(reason: "Double is not supported on the wire")
    }

    mutating func encode(_ value: Float) throws {
        throw SomnioProtocolError.invalidPayload(reason: "Float is not supported on the wire")
    }

    mutating func encode(_ value: Int) throws {
        throw SomnioProtocolError.invalidPayload(reason: "Int has variable platform width; use Int16/Int32")
    }

    mutating func encode(_ value: Int8) throws {
        encoder.writeUInt8(UInt8(bitPattern: value))
    }

    mutating func encode(_ value: Int64) throws {
        throw SomnioProtocolError.invalidPayload(reason: "Int64 is not supported on the wire")
    }

    mutating func encode(_ value: UInt) throws {
        throw SomnioProtocolError.invalidPayload(reason: "UInt has variable platform width; use UInt16/UInt32")
    }

    mutating func encode(_ value: UInt64) throws {
        throw SomnioProtocolError.invalidPayload(reason: "UInt64 is not supported on the wire")
    }

    mutating func encode(_ value: some Encodable) throws {
        try value.encode(to: encoder)
    }
}
