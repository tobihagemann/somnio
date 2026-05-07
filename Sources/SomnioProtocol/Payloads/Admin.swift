import Foundation

/// Discriminated-union for the `/admin` WebSocket request/response set. The verb is always
/// the first byte of the encoded form; payload-bearing variants append a `u16 LE`
/// length-prefixed UTF-8 string.
public enum AdminRequest: Sendable, Equatable {
    case log
    case weblog
    case players
    case time
    case say(text: String)
    case kick(name: String)
    case version
    case logRemove
    case weblogRemove
}

extension AdminRequest: Codable {
    private enum AdminCodingKeys: String, CodingKey { case tag; case payload }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: AdminCodingKeys.self)
        let tag = try container.decode(UInt8.self, forKey: .tag)
        switch tag {
        case 0: self = .log
        case 1: self = .weblog
        case 2: self = .players
        case 3: self = .time
        case 4: self = try .say(text: container.decode(String.self, forKey: .payload))
        case 5: self = try .kick(name: container.decode(String.self, forKey: .payload))
        case 6: self = .version
        case 7: self = .logRemove
        case 8: self = .weblogRemove
        default: throw SomnioProtocolError.unrecognizedTag(tag)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: AdminCodingKeys.self)
        switch self {
        case .log: try container.encode(UInt8(0), forKey: .tag)
        case .weblog: try container.encode(UInt8(1), forKey: .tag)
        case .players: try container.encode(UInt8(2), forKey: .tag)
        case .time: try container.encode(UInt8(3), forKey: .tag)
        case let .say(text):
            try container.encode(UInt8(4), forKey: .tag)
            try container.encode(text, forKey: .payload)
        case let .kick(name):
            try container.encode(UInt8(5), forKey: .tag)
            try container.encode(name, forKey: .payload)
        case .version: try container.encode(UInt8(6), forKey: .tag)
        case .logRemove: try container.encode(UInt8(7), forKey: .tag)
        case .weblogRemove: try container.encode(UInt8(8), forKey: .tag)
        }
    }
}

/// Server reply to an `AdminRequest`. The first byte echoes the request verb; payload-bearing
/// responses append a `u16 LE` length-prefixed UTF-8 string carrying the localized output the
/// CLI prints to the operator's terminal.
public enum AdminResponse: Sendable, Equatable {
    case logContents(text: String)
    case weblogContents(text: String)
    case logEmpty
    case logRemoved
    case weblogEmpty
    case weblogRemoved
    case playerCount(text: String)
    case worldClock(text: String)
    case sayBroadcast(text: String)
    case kickedPlayer(text: String)
    case kickedPlayerNotFound(text: String)
    case versionString(text: String)
    case unknownCommand
}

extension AdminResponse: Codable {
    private enum AdminCodingKeys: String, CodingKey { case tag; case payload }

    // swiftlint:disable:next cyclomatic_complexity
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: AdminCodingKeys.self)
        let tag = try container.decode(UInt8.self, forKey: .tag)
        switch tag {
        case 0: self = try .logContents(text: container.decode(String.self, forKey: .payload))
        case 1: self = try .weblogContents(text: container.decode(String.self, forKey: .payload))
        case 2: self = .logEmpty
        case 3: self = .logRemoved
        case 4: self = .weblogEmpty
        case 5: self = .weblogRemoved
        case 6: self = try .playerCount(text: container.decode(String.self, forKey: .payload))
        case 7: self = try .worldClock(text: container.decode(String.self, forKey: .payload))
        case 8: self = try .sayBroadcast(text: container.decode(String.self, forKey: .payload))
        case 9: self = try .kickedPlayer(text: container.decode(String.self, forKey: .payload))
        case 10: self = try .kickedPlayerNotFound(text: container.decode(String.self, forKey: .payload))
        case 11: self = try .versionString(text: container.decode(String.self, forKey: .payload))
        case 12: self = .unknownCommand
        default: throw SomnioProtocolError.unrecognizedTag(tag)
        }
    }

    // swiftlint:disable:next cyclomatic_complexity
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: AdminCodingKeys.self)
        switch self {
        case let .logContents(text):
            try container.encode(UInt8(0), forKey: .tag); try container.encode(text, forKey: .payload)
        case let .weblogContents(text):
            try container.encode(UInt8(1), forKey: .tag); try container.encode(text, forKey: .payload)
        case .logEmpty: try container.encode(UInt8(2), forKey: .tag)
        case .logRemoved: try container.encode(UInt8(3), forKey: .tag)
        case .weblogEmpty: try container.encode(UInt8(4), forKey: .tag)
        case .weblogRemoved: try container.encode(UInt8(5), forKey: .tag)
        case let .playerCount(text):
            try container.encode(UInt8(6), forKey: .tag); try container.encode(text, forKey: .payload)
        case let .worldClock(text):
            try container.encode(UInt8(7), forKey: .tag); try container.encode(text, forKey: .payload)
        case let .sayBroadcast(text):
            try container.encode(UInt8(8), forKey: .tag); try container.encode(text, forKey: .payload)
        case let .kickedPlayer(text):
            try container.encode(UInt8(9), forKey: .tag); try container.encode(text, forKey: .payload)
        case let .kickedPlayerNotFound(text):
            try container.encode(UInt8(10), forKey: .tag); try container.encode(text, forKey: .payload)
        case let .versionString(text):
            try container.encode(UInt8(11), forKey: .tag); try container.encode(text, forKey: .payload)
        case .unknownCommand: try container.encode(UInt8(12), forKey: .tag)
        }
    }
}
