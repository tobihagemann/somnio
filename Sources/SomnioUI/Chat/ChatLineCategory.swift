import Foundation

/// Visual-treatment bucket for a chat scrollback row. `ChatLineStyle.style(for:)`
/// switches on this enum to pick the foreground color, weight, and slant. Multiple
/// `ChatLine` variants can share a category (e.g. own / peer / NPC spoken lines all
/// trace back to `.peerMessage` vs `.ownMessage` etc.).
public enum ChatLineCategory: Sendable, Equatable, Hashable, CaseIterable {
    case ownMessage
    case peerMessage
    case npcMessage
    case adminBroadcast
    case error
    case joinLeave
    case startupGreeting
}
