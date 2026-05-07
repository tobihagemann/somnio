import Foundation

/// Custom `Codable` for `SomnioMessage`. Encodes as `[u8 tag][payload]` (without the outer
/// `[u32 LE payload_length]` framing — that lives in `SomnioMessageEncoder.encode`). Decodes
/// the same shape via the leading `u8` tag, dispatching to the matching payload type.
///
/// This conformance only fires when `SomnioMessage` is nested inside another `Codable` value;
/// the framing-aware path runs through `SomnioMessageEncoder` / `SomnioMessageDecoder`.
extension SomnioMessage: Codable {
    private enum SomnioMessageCodingKeys: String, CodingKey { case tag; case payload }

    // swiftlint:disable:next cyclomatic_complexity
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: SomnioMessageCodingKeys.self)
        let tagByte = try container.decode(UInt8.self, forKey: .tag)
        guard let tag = SomnioMessageTag(rawValue: tagByte) else {
            throw SomnioProtocolError.unrecognizedTag(tagByte)
        }
        switch tag {
        case .login: self = try .login(container.decode(LoginMessage.self, forKey: .payload))
        case .register: self = try .register(container.decode(RegisterMessage.self, forKey: .payload))
        case .clientPosition: self = try .clientPosition(container.decode(PositionMessage.self, forKey: .payload))
        case .clientSay: self = try .clientSay(container.decode(SayMessage.self, forKey: .payload))
        case .equipToggle: self = try .equipToggle(container.decode(EquipToggleMessage.self, forKey: .payload))
        case .bumpNPC: self = try .bumpNPC(container.decode(BumpNPCMessage.self, forKey: .payload))
        case .enterPortal: self = try .enterPortal(container.decode(EnterPortalMessage.self, forKey: .payload))
        case .hello: self = try .hello(container.decode(HelloMessage.self, forKey: .payload))
        case .loginResult: self = try .loginResult(container.decode(LoginResultMessage.self, forKey: .payload))
        case .registerResult: self = try .registerResult(container.decode(RegisterResultMessage.self, forKey: .payload))
        case .enterSector: self = try .enterSector(container.decode(EnterSectorMessage.self, forKey: .payload))
        case .mainCharacter: self = try .mainCharacter(container.decode(MainCharacterMessage.self, forKey: .payload))
        case .entity: self = try .entity(container.decode(EntityMessage.self, forKey: .payload))
        case .serverPosition: self = try .serverPosition(container.decode(PositionMessage.self, forKey: .payload))
        case .serverSay: self = try .serverSay(container.decode(SayMessage.self, forKey: .payload))
        case .energy: self = try .energy(container.decode(Energy.self, forKey: .payload))
        case .dateTick: self = try .dateTick(container.decode(DateTickMessage.self, forKey: .payload))
        case .inventory: self = try .inventory(container.decode(InventoryMessage.self, forKey: .payload))
        case .leave: self = try .leave(container.decode(LeaveMessage.self, forKey: .payload))
        case .adminSay: self = try .adminSay(container.decode(AdminSayMessage.self, forKey: .payload))
        }
    }

    // swiftlint:disable:next cyclomatic_complexity
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: SomnioMessageCodingKeys.self)
        try container.encode(tag.rawValue, forKey: .tag)
        switch self {
        case let .login(m): try container.encode(m, forKey: .payload)
        case let .register(m): try container.encode(m, forKey: .payload)
        case let .clientPosition(m): try container.encode(m, forKey: .payload)
        case let .clientSay(m): try container.encode(m, forKey: .payload)
        case let .equipToggle(m): try container.encode(m, forKey: .payload)
        case let .bumpNPC(m): try container.encode(m, forKey: .payload)
        case let .enterPortal(m): try container.encode(m, forKey: .payload)
        case let .hello(m): try container.encode(m, forKey: .payload)
        case let .loginResult(m): try container.encode(m, forKey: .payload)
        case let .registerResult(m): try container.encode(m, forKey: .payload)
        case let .enterSector(m): try container.encode(m, forKey: .payload)
        case let .mainCharacter(m): try container.encode(m, forKey: .payload)
        case let .entity(m): try container.encode(m, forKey: .payload)
        case let .serverPosition(m): try container.encode(m, forKey: .payload)
        case let .serverSay(m): try container.encode(m, forKey: .payload)
        case let .energy(m): try container.encode(m, forKey: .payload)
        case let .dateTick(m): try container.encode(m, forKey: .payload)
        case let .inventory(m): try container.encode(m, forKey: .payload)
        case let .leave(m): try container.encode(m, forKey: .payload)
        case let .adminSay(m): try container.encode(m, forKey: .payload)
        }
    }
}

/// Single parser entrypoint. Reads `[u8 tag][u32 LE payload_length][payload]`; rejects
/// oversized frames, truncated input, and unknown tags per `SomnioProtocolError`.
public enum SomnioMessageDecoder {
    // swiftlint:disable:next cyclomatic_complexity
    public static func decode(_ data: Data) throws -> SomnioMessage {
        guard data.count >= 5 else { throw SomnioProtocolError.truncated }
        let tagByte = data[data.startIndex]
        guard let tag = SomnioMessageTag(rawValue: tagByte) else {
            throw SomnioProtocolError.unrecognizedTag(tagByte)
        }
        let payloadLength = readUInt32LE(data, at: data.startIndex + 1)
        guard payloadLength <= SomnioProtocolConstants.maxFrameLength else {
            throw SomnioProtocolError.oversizedFrame(payloadLength)
        }
        let payloadStart = data.startIndex + 5
        let payloadEnd = payloadStart + Int(payloadLength)
        guard payloadEnd <= data.endIndex else {
            throw SomnioProtocolError.truncated
        }
        guard payloadEnd == data.endIndex else {
            throw SomnioProtocolError.invalidPayload(reason: "trailing \(data.endIndex - payloadEnd) byte(s) past end of frame")
        }
        let payload = data[payloadStart ..< payloadEnd]
        let decoder = BinaryDecoder()

        switch tag {
        case .login: return try .login(decoder.decode(LoginMessage.self, from: payload))
        case .register: return try .register(decoder.decode(RegisterMessage.self, from: payload))
        case .clientPosition: return try .clientPosition(decoder.decode(PositionMessage.self, from: payload))
        case .clientSay: return try .clientSay(decoder.decode(SayMessage.self, from: payload))
        case .equipToggle: return try .equipToggle(decoder.decode(EquipToggleMessage.self, from: payload))
        case .bumpNPC: return try .bumpNPC(decoder.decode(BumpNPCMessage.self, from: payload))
        case .enterPortal: return try .enterPortal(decoder.decode(EnterPortalMessage.self, from: payload))
        case .hello: return try .hello(decoder.decode(HelloMessage.self, from: payload))
        case .loginResult: return try .loginResult(decoder.decode(LoginResultMessage.self, from: payload))
        case .registerResult: return try .registerResult(decoder.decode(RegisterResultMessage.self, from: payload))
        case .enterSector: return try .enterSector(decoder.decode(EnterSectorMessage.self, from: payload))
        case .mainCharacter: return try .mainCharacter(decoder.decode(MainCharacterMessage.self, from: payload))
        case .entity: return try .entity(decoder.decode(EntityMessage.self, from: payload))
        case .serverPosition: return try .serverPosition(decoder.decode(PositionMessage.self, from: payload))
        case .serverSay: return try .serverSay(decoder.decode(SayMessage.self, from: payload))
        case .energy: return try .energy(decoder.decode(Energy.self, from: payload))
        case .dateTick: return try .dateTick(decoder.decode(DateTickMessage.self, from: payload))
        case .inventory: return try .inventory(decoder.decode(InventoryMessage.self, from: payload))
        case .leave: return try .leave(decoder.decode(LeaveMessage.self, from: payload))
        case .adminSay: return try .adminSay(decoder.decode(AdminSayMessage.self, from: payload))
        }
    }
}

/// Single emitter entrypoint. Emits `[u8 tag][u32 LE payload_length][payload]`.
public enum SomnioMessageEncoder {
    // swiftlint:disable:next cyclomatic_complexity
    public static func encode(_ message: SomnioMessage) throws -> Data {
        let encoder = BinaryEncoder()
        let payload: Data = try {
            switch message {
            case let .login(m): return try encoder.encode(m)
            case let .register(m): return try encoder.encode(m)
            case let .clientPosition(m): return try encoder.encode(m)
            case let .clientSay(m): return try encoder.encode(m)
            case let .equipToggle(m): return try encoder.encode(m)
            case let .bumpNPC(m): return try encoder.encode(m)
            case let .enterPortal(m): return try encoder.encode(m)
            case let .hello(m): return try encoder.encode(m)
            case let .loginResult(m): return try encoder.encode(m)
            case let .registerResult(m): return try encoder.encode(m)
            case let .enterSector(m): return try encoder.encode(m)
            case let .mainCharacter(m): return try encoder.encode(m)
            case let .entity(m): return try encoder.encode(m)
            case let .serverPosition(m): return try encoder.encode(m)
            case let .serverSay(m): return try encoder.encode(m)
            case let .energy(m): return try encoder.encode(m)
            case let .dateTick(m): return try encoder.encode(m)
            case let .inventory(m): return try encoder.encode(m)
            case let .leave(m): return try encoder.encode(m)
            case let .adminSay(m): return try encoder.encode(m)
            }
        }()
        guard payload.count <= Int(SomnioProtocolConstants.maxFrameLength) else {
            throw SomnioProtocolError.oversizedFrame(UInt32(payload.count))
        }

        var frame = Data(capacity: 5 + payload.count)
        frame.append(message.tag.rawValue)
        appendUInt32LE(UInt32(payload.count), to: &frame)
        frame.append(payload)
        return frame
    }
}

// File-private helpers shared between the encoder and decoder so the u32 LE wire
// representation lives in one place.

private func appendUInt32LE(_ value: UInt32, to data: inout Data) {
    data.append(UInt8(value & 0xFF))
    data.append(UInt8((value >> 8) & 0xFF))
    data.append(UInt8((value >> 16) & 0xFF))
    data.append(UInt8((value >> 24) & 0xFF))
}

private func readUInt32LE(_ data: Data, at offset: Int) -> UInt32 {
    UInt32(data[offset])
        | (UInt32(data[offset + 1]) << 8)
        | (UInt32(data[offset + 2]) << 16)
        | (UInt32(data[offset + 3]) << 24)
}
