import Foundation

/// Project-defined binary `Decoder` for the wire protocol. Symmetric with `BinaryEncoder`:
/// keyed containers walk fields in `CodingKeys` declaration order regardless of the key string.
public final class BinaryDecoder: Decoder {
    public var codingPath: [CodingKey] = []
    public var userInfo: [CodingUserInfoKey: Any] = [:]

    var buffer: Data = .init()
    var offset: Int = 0

    public init() {}

    public func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        buffer = data
        offset = 0
        let value = try T(from: self)
        guard offset == buffer.count else {
            throw SomnioProtocolError.invalidPayload(reason: "trailing \(buffer.count - offset) byte(s) past end of \(type)")
        }
        return value
    }

    public func container<Key: CodingKey>(keyedBy type: Key.Type) throws -> KeyedDecodingContainer<Key> {
        KeyedDecodingContainer(BinaryKeyedDecodingContainer<Key>(decoder: self))
    }

    public func unkeyedContainer() throws -> UnkeyedDecodingContainer {
        try BinaryUnkeyedDecodingContainer(decoder: self)
    }

    public func singleValueContainer() throws -> SingleValueDecodingContainer {
        BinarySingleValueDecodingContainer(decoder: self)
    }

    // MARK: - Primitive reads

    func readUInt8() throws -> UInt8 {
        guard offset < buffer.count else { throw SomnioProtocolError.truncated }
        let byte = buffer[buffer.startIndex + offset]
        offset += 1
        return byte
    }

    func readUInt16LE() throws -> UInt16 {
        guard offset + 2 <= buffer.count else { throw SomnioProtocolError.truncated }
        let lo = UInt16(buffer[buffer.startIndex + offset])
        let hi = UInt16(buffer[buffer.startIndex + offset + 1])
        offset += 2
        return (hi << 8) | lo
    }

    func readUInt32LE() throws -> UInt32 {
        guard offset + 4 <= buffer.count else { throw SomnioProtocolError.truncated }
        let b0 = UInt32(buffer[buffer.startIndex + offset])
        let b1 = UInt32(buffer[buffer.startIndex + offset + 1])
        let b2 = UInt32(buffer[buffer.startIndex + offset + 2])
        let b3 = UInt32(buffer[buffer.startIndex + offset + 3])
        offset += 4
        return (b3 << 24) | (b2 << 16) | (b1 << 8) | b0
    }

    func readInt16LE() throws -> Int16 {
        try Int16(bitPattern: readUInt16LE())
    }

    func readInt32LE() throws -> Int32 {
        try Int32(bitPattern: readUInt32LE())
    }

    func readBool() throws -> Bool {
        try readUInt8() != 0
    }

    func readString() throws -> String {
        let len = try Int(readUInt16LE())
        guard offset + len <= buffer.count else { throw SomnioProtocolError.truncated }
        let range = (buffer.startIndex + offset) ..< (buffer.startIndex + offset + len)
        let bytes = buffer[range]
        offset += len
        guard let s = String(data: bytes, encoding: .utf8) else {
            throw SomnioProtocolError.invalidPayload(reason: "invalid UTF-8 in string field")
        }
        return s
    }
}

// MARK: - Keyed container

private struct BinaryKeyedDecodingContainer<Key: CodingKey>: KeyedDecodingContainerProtocol {
    let decoder: BinaryDecoder
    var codingPath: [CodingKey] {
        decoder.codingPath
    }

    var allKeys: [Key] {
        []
    }

    func contains(_ key: Key) -> Bool {
        true
    }

    func decodeNil(forKey key: Key) throws -> Bool {
        false
    }

    func decode(_ type: Bool.Type, forKey key: Key) throws -> Bool {
        try decoder.readBool()
    }

    func decode(_ type: String.Type, forKey key: Key) throws -> String {
        try decoder.readString()
    }

    func decode(_ type: Double.Type, forKey key: Key) throws -> Double {
        throw SomnioProtocolError.invalidPayload(reason: "Double is not supported on the wire")
    }

    func decode(_ type: Float.Type, forKey key: Key) throws -> Float {
        throw SomnioProtocolError.invalidPayload(reason: "Float is not supported on the wire")
    }

    func decode(_ type: Int.Type, forKey key: Key) throws -> Int {
        throw SomnioProtocolError.invalidPayload(reason: "Int has variable platform width; use Int16/Int32")
    }

    func decode(_ type: Int8.Type, forKey key: Key) throws -> Int8 {
        try Int8(bitPattern: decoder.readUInt8())
    }

    func decode(_ type: Int16.Type, forKey key: Key) throws -> Int16 {
        try decoder.readInt16LE()
    }

    func decode(_ type: Int32.Type, forKey key: Key) throws -> Int32 {
        try decoder.readInt32LE()
    }

    func decode(_ type: Int64.Type, forKey key: Key) throws -> Int64 {
        throw SomnioProtocolError.invalidPayload(reason: "Int64 is not supported on the wire")
    }

    func decode(_ type: UInt.Type, forKey key: Key) throws -> UInt {
        throw SomnioProtocolError.invalidPayload(reason: "UInt has variable platform width; use UInt16/UInt32")
    }

    func decode(_ type: UInt8.Type, forKey key: Key) throws -> UInt8 {
        try decoder.readUInt8()
    }

    func decode(_ type: UInt16.Type, forKey key: Key) throws -> UInt16 {
        try decoder.readUInt16LE()
    }

    func decode(_ type: UInt32.Type, forKey key: Key) throws -> UInt32 {
        try decoder.readUInt32LE()
    }

    func decode(_ type: UInt64.Type, forKey key: Key) throws -> UInt64 {
        throw SomnioProtocolError.invalidPayload(reason: "UInt64 is not supported on the wire")
    }

    func decode<T: Decodable>(_ type: T.Type, forKey key: Key) throws -> T {
        try T(from: decoder)
    }

    func nestedContainer<NestedKey: CodingKey>(keyedBy type: NestedKey.Type, forKey key: Key) throws -> KeyedDecodingContainer<NestedKey> {
        try decoder.container(keyedBy: type)
    }

    func nestedUnkeyedContainer(forKey key: Key) throws -> UnkeyedDecodingContainer {
        try decoder.unkeyedContainer()
    }

    func superDecoder() throws -> Decoder {
        decoder
    }

    func superDecoder(forKey key: Key) throws -> Decoder {
        decoder
    }
}

// MARK: - Unkeyed container (arrays)

private struct BinaryUnkeyedDecodingContainer: UnkeyedDecodingContainer {
    let decoder: BinaryDecoder
    var codingPath: [CodingKey] {
        decoder.codingPath
    }

    let count: Int?
    var currentIndex: Int = 0

    var isAtEnd: Bool {
        currentIndex >= (count ?? 0)
    }

    init(decoder: BinaryDecoder) throws {
        self.decoder = decoder
        self.count = try Int(decoder.readUInt16LE())
    }

    mutating func decodeNil() throws -> Bool {
        false
    }

    mutating func decode(_ type: Bool.Type) throws -> Bool {
        defer { currentIndex += 1 }; return try decoder.readBool()
    }

    mutating func decode(_ type: String.Type) throws -> String {
        defer { currentIndex += 1 }; return try decoder.readString()
    }

    mutating func decode(_ type: Int16.Type) throws -> Int16 {
        defer { currentIndex += 1 }; return try decoder.readInt16LE()
    }

    mutating func decode(_ type: Int32.Type) throws -> Int32 {
        defer { currentIndex += 1 }; return try decoder.readInt32LE()
    }

    mutating func decode(_ type: UInt8.Type) throws -> UInt8 {
        defer { currentIndex += 1 }; return try decoder.readUInt8()
    }

    mutating func decode(_ type: UInt16.Type) throws -> UInt16 {
        defer { currentIndex += 1 }; return try decoder.readUInt16LE()
    }

    mutating func decode(_ type: UInt32.Type) throws -> UInt32 {
        defer { currentIndex += 1 }; return try decoder.readUInt32LE()
    }

    mutating func decode<T: Decodable>(_ type: T.Type) throws -> T {
        defer { currentIndex += 1 }
        return try T(from: decoder)
    }

    mutating func nestedContainer<NestedKey: CodingKey>(keyedBy type: NestedKey.Type) throws -> KeyedDecodingContainer<NestedKey> {
        try decoder.container(keyedBy: type)
    }

    mutating func nestedUnkeyedContainer() throws -> UnkeyedDecodingContainer {
        try decoder.unkeyedContainer()
    }

    mutating func superDecoder() throws -> Decoder {
        decoder
    }
}

// MARK: - Single-value container

private struct BinarySingleValueDecodingContainer: SingleValueDecodingContainer {
    let decoder: BinaryDecoder
    var codingPath: [CodingKey] {
        decoder.codingPath
    }

    func decodeNil() -> Bool {
        false
    }

    func decode(_ type: Bool.Type) throws -> Bool {
        try decoder.readBool()
    }

    func decode(_ type: String.Type) throws -> String {
        try decoder.readString()
    }

    func decode(_ type: Int16.Type) throws -> Int16 {
        try decoder.readInt16LE()
    }

    func decode(_ type: Int32.Type) throws -> Int32 {
        try decoder.readInt32LE()
    }

    func decode(_ type: UInt8.Type) throws -> UInt8 {
        try decoder.readUInt8()
    }

    func decode(_ type: UInt16.Type) throws -> UInt16 {
        try decoder.readUInt16LE()
    }

    func decode(_ type: UInt32.Type) throws -> UInt32 {
        try decoder.readUInt32LE()
    }

    func decode(_ type: Double.Type) throws -> Double {
        throw SomnioProtocolError.invalidPayload(reason: "Double is not supported on the wire")
    }

    func decode(_ type: Float.Type) throws -> Float {
        throw SomnioProtocolError.invalidPayload(reason: "Float is not supported on the wire")
    }

    func decode(_ type: Int.Type) throws -> Int {
        throw SomnioProtocolError.invalidPayload(reason: "Int has variable platform width; use Int16/Int32")
    }

    func decode(_ type: Int8.Type) throws -> Int8 {
        try Int8(bitPattern: decoder.readUInt8())
    }

    func decode(_ type: Int64.Type) throws -> Int64 {
        throw SomnioProtocolError.invalidPayload(reason: "Int64 is not supported on the wire")
    }

    func decode(_ type: UInt.Type) throws -> UInt {
        throw SomnioProtocolError.invalidPayload(reason: "UInt has variable platform width; use UInt16/UInt32")
    }

    func decode(_ type: UInt64.Type) throws -> UInt64 {
        throw SomnioProtocolError.invalidPayload(reason: "UInt64 is not supported on the wire")
    }

    func decode<T: Decodable>(_ type: T.Type) throws -> T {
        try T(from: decoder)
    }
}
