import SwiftUI

public extension ChatColor {
    /// The SwiftUI `Color` for this palette entry. The hex values match the legacy
    /// `Schreiben(text, color, ...)` triples: purple `RGB(128, 0, 128)` for own messages,
    /// red `RGB(192, 0, 0)` for admin broadcasts and errors, blue for joins and the
    /// startup greeting, plain black for everyone else.
    var color: Color {
        switch self {
        case .purple: return Color(red: 128 / 255, green: 0, blue: 128 / 255)
        case .red: return Color(red: 192 / 255, green: 0, blue: 0)
        case .blue: return .blue
        case .black: return .black
        }
    }
}
