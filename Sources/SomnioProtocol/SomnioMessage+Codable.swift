import Foundation

/// `Codable` for `SomnioMessage`. Encodes as the keyed JSON shape `{"tag":"<verb>","payload":{...}}`,
/// dispatching to the matching payload type via the string discriminator. `SomnioMessageEncoder` /
/// `SomnioMessageDecoder` are thin wrappers that move this shape across the WebSocket text frame.
extension SomnioMessage: Codable {
    private enum SomnioMessageCodingKeys: String, CodingKey { case tag; case payload }

    // swiftlint:disable:next cyclomatic_complexity
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: SomnioMessageCodingKeys.self)
        let tagString = try container.decode(String.self, forKey: .tag)
        guard let tag = SomnioMessageTag(rawValue: tagString) else {
            throw SomnioProtocolError.unrecognizedTag(tagString)
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

/// Single parser entrypoint. Decodes one JSON text frame into a `SomnioMessage`. Malformed input
/// surfaces as `Swift.DecodingError`; an unknown discriminator surfaces as
/// `SomnioProtocolError.unrecognizedTag` from the hand-written `SomnioMessage.init(from:)`.
public enum SomnioMessageDecoder {
    public static func decode(_ data: Data) throws -> SomnioMessage {
        try JSONDecoder().decode(SomnioMessage.self, from: data)
    }
}

/// Single emitter entrypoint. Encodes a `SomnioMessage` as UTF-8 JSON bytes. Guards against an
/// oversized frame so an abusive `EnterSector` throws cleanly rather than tripping the receiver's
/// `maxFrameSize` hard close.
public enum SomnioMessageEncoder {
    public static func encode(_ message: SomnioMessage) throws -> Data {
        let data = try JSONEncoder().encode(message)
        guard data.count <= Int(SomnioProtocolConstants.maxFrameLength) else {
            throw SomnioProtocolError.oversizedFrame(UInt32(data.count))
        }
        return data
    }
}
