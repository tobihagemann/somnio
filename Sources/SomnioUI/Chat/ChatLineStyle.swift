import Foundation

/// Palette for chat scrollback rows, mirroring the legacy `Schreiben(text, color, ...)`
/// call site's discrete color set.
public enum ChatColor: Sendable, Equatable, Hashable, CaseIterable {
    case purple
    case red
    case blue
    case black
}

/// Visual treatment applied to one chat scrollback row.
public struct ChatLineStyle: Sendable, Equatable, Hashable {
    public var foreground: ChatColor
    public var bold: Bool
    public var italic: Bool

    public init(foreground: ChatColor, bold: Bool, italic: Bool) {
        self.foreground = foreground
        self.bold = bold
        self.italic = italic
    }

    /// Resolves the visual treatment for the given category. Exhaustive on every
    /// `ChatLineCategory` case so a new bucket is a build-time error.
    public static func style(for category: ChatLineCategory) -> ChatLineStyle {
        switch category {
        case .ownMessage:
            return ChatLineStyle(foreground: .purple, bold: false, italic: false)
        case .peerMessage, .npcMessage:
            return ChatLineStyle(foreground: .black, bold: false, italic: false)
        case .adminBroadcast, .error:
            return ChatLineStyle(foreground: .red, bold: false, italic: false)
        case .joinLeave, .startupGreeting:
            return ChatLineStyle(foreground: .blue, bold: false, italic: true)
        }
    }
}
