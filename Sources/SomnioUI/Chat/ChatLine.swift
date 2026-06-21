import Foundation

/// A renderable chat scrollback event. Each case maps to exactly one catalog key in
/// `ChatLineRenderer`. The German strings surface only through the bilingual catalog;
/// identifiers stay English per the project's identifier-translation rule.
public enum ChatLine: Sendable, Equatable, Hashable {
    case spokenByOwn(senderName: String, message: String)
    case spokenByPeer(senderName: String, message: String)
    case spokenByNPC(senderName: String, message: String)
    case adminBroadcast(message: String)
    case connectionLost
    case serverUnreachable
    case badCredentials
    case alreadyLoggedIn
    case credentialSaveFailed
    case errorCode(code: String)
    case joined(playerName: String)
    case left(playerName: String)
    case startupGreeting
    /// Coin balance reported when the purse is double-clicked. The legacy original wrote this to
    /// the chat log ("Du besitzt Nc.") in plain body text, not to the inventory row.
    case purseBalance(coins: Int16)

    /// The visual-treatment bucket that selects this line's foreground color, weight,
    /// and slant via `ChatLineStyle.style(for:)`.
    public var category: ChatLineCategory {
        switch self {
        case .spokenByOwn: return .ownMessage
        case .spokenByPeer: return .peerMessage
        case .spokenByNPC: return .npcMessage
        case .adminBroadcast: return .adminBroadcast
        case .connectionLost, .serverUnreachable, .badCredentials, .alreadyLoggedIn, .credentialSaveFailed, .errorCode: return .error
        case .joined, .left: return .joinLeave
        case .startupGreeting: return .startupGreeting
        case .purseBalance: return .itemInfo
        }
    }
}
