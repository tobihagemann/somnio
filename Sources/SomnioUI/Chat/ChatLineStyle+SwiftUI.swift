import SwiftUI

public extension ChatColor {
    /// The SwiftUI `Color` for this palette entry. The buckets match the legacy
    /// `Schreiben(text, color, ...)` triples — purple for own messages, red for admin
    /// broadcasts and errors, blue for joins and the startup greeting — but the hues are
    /// brightened for the game-styled chat panel, whose plate is dark in either system
    /// appearance (the legacy dark-on-white values vanish against it).
    var color: Color {
        switch self {
        case .purple: return Color(red: 216 / 255, green: 140 / 255, blue: 232 / 255)
        case .red: return FantasyPalette.errorRed
        case .blue: return Color(red: 130 / 255, green: 180 / 255, blue: 255 / 255)
        case .primary: return .white
        }
    }
}
