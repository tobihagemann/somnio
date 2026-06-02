import Foundation

/// Discriminated-union for the `/admin` WebSocket request/response set. Travels as JSON over
/// text frames in the shape `{"tag":"<verb>","payload":"<text>"}`; payload-bearing variants
/// carry their string in `payload`.
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
    private enum Tag: String { case log, weblog, players, time, say, kick, version, logRemove, weblogRemove }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: AdminCodingKeys.self)
        let tagString = try container.decode(String.self, forKey: .tag)
        guard let tag = Tag(rawValue: tagString) else {
            throw SomnioProtocolError.unrecognizedTag(tagString)
        }
        switch tag {
        case .log: self = .log
        case .weblog: self = .weblog
        case .players: self = .players
        case .time: self = .time
        case .say: self = try .say(text: container.decode(String.self, forKey: .payload))
        case .kick: self = try .kick(name: container.decode(String.self, forKey: .payload))
        case .version: self = .version
        case .logRemove: self = .logRemove
        case .weblogRemove: self = .weblogRemove
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: AdminCodingKeys.self)
        switch self {
        case .log: try container.encode(Tag.log.rawValue, forKey: .tag)
        case .weblog: try container.encode(Tag.weblog.rawValue, forKey: .tag)
        case .players: try container.encode(Tag.players.rawValue, forKey: .tag)
        case .time: try container.encode(Tag.time.rawValue, forKey: .tag)
        case let .say(text):
            try container.encode(Tag.say.rawValue, forKey: .tag)
            try container.encode(text, forKey: .payload)
        case let .kick(name):
            try container.encode(Tag.kick.rawValue, forKey: .tag)
            try container.encode(name, forKey: .payload)
        case .version: try container.encode(Tag.version.rawValue, forKey: .tag)
        case .logRemove: try container.encode(Tag.logRemove.rawValue, forKey: .tag)
        case .weblogRemove: try container.encode(Tag.weblogRemove.rawValue, forKey: .tag)
        }
    }
}

/// Server reply to an `AdminRequest`. Travels as JSON over text frames in the shape
/// `{"tag":"<verb>","payload":"<text>"}`; payload-bearing responses carry the localized output
/// the CLI prints to the operator's terminal in `payload`.
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
    private enum Tag: String {
        case logContents, weblogContents, logEmpty, logRemoved, weblogEmpty, weblogRemoved
        case playerCount, worldClock, sayBroadcast, kickedPlayer, kickedPlayerNotFound
        case versionString, unknownCommand
    }

    // swiftlint:disable:next cyclomatic_complexity
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: AdminCodingKeys.self)
        let tagString = try container.decode(String.self, forKey: .tag)
        guard let tag = Tag(rawValue: tagString) else {
            throw SomnioProtocolError.unrecognizedTag(tagString)
        }
        switch tag {
        case .logContents: self = try .logContents(text: container.decode(String.self, forKey: .payload))
        case .weblogContents: self = try .weblogContents(text: container.decode(String.self, forKey: .payload))
        case .logEmpty: self = .logEmpty
        case .logRemoved: self = .logRemoved
        case .weblogEmpty: self = .weblogEmpty
        case .weblogRemoved: self = .weblogRemoved
        case .playerCount: self = try .playerCount(text: container.decode(String.self, forKey: .payload))
        case .worldClock: self = try .worldClock(text: container.decode(String.self, forKey: .payload))
        case .sayBroadcast: self = try .sayBroadcast(text: container.decode(String.self, forKey: .payload))
        case .kickedPlayer: self = try .kickedPlayer(text: container.decode(String.self, forKey: .payload))
        case .kickedPlayerNotFound: self = try .kickedPlayerNotFound(text: container.decode(String.self, forKey: .payload))
        case .versionString: self = try .versionString(text: container.decode(String.self, forKey: .payload))
        case .unknownCommand: self = .unknownCommand
        }
    }

    // swiftlint:disable:next cyclomatic_complexity
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: AdminCodingKeys.self)
        switch self {
        case let .logContents(text):
            try container.encode(Tag.logContents.rawValue, forKey: .tag); try container.encode(text, forKey: .payload)
        case let .weblogContents(text):
            try container.encode(Tag.weblogContents.rawValue, forKey: .tag); try container.encode(text, forKey: .payload)
        case .logEmpty: try container.encode(Tag.logEmpty.rawValue, forKey: .tag)
        case .logRemoved: try container.encode(Tag.logRemoved.rawValue, forKey: .tag)
        case .weblogEmpty: try container.encode(Tag.weblogEmpty.rawValue, forKey: .tag)
        case .weblogRemoved: try container.encode(Tag.weblogRemoved.rawValue, forKey: .tag)
        case let .playerCount(text):
            try container.encode(Tag.playerCount.rawValue, forKey: .tag); try container.encode(text, forKey: .payload)
        case let .worldClock(text):
            try container.encode(Tag.worldClock.rawValue, forKey: .tag); try container.encode(text, forKey: .payload)
        case let .sayBroadcast(text):
            try container.encode(Tag.sayBroadcast.rawValue, forKey: .tag); try container.encode(text, forKey: .payload)
        case let .kickedPlayer(text):
            try container.encode(Tag.kickedPlayer.rawValue, forKey: .tag); try container.encode(text, forKey: .payload)
        case let .kickedPlayerNotFound(text):
            try container.encode(Tag.kickedPlayerNotFound.rawValue, forKey: .tag); try container.encode(text, forKey: .payload)
        case let .versionString(text):
            try container.encode(Tag.versionString.rawValue, forKey: .tag); try container.encode(text, forKey: .payload)
        case .unknownCommand: try container.encode(Tag.unknownCommand.rawValue, forKey: .tag)
        }
    }
}
