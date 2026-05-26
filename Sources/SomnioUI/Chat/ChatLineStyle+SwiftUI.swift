import SwiftUI

public extension ChatColor {
    /// The SwiftUI `Color` for this palette entry. The brand hues match the legacy
    /// `Schreiben(text, color, ...)` triples: purple `RGB(128, 0, 128)` for own messages,
    /// red `RGB(192, 0, 0)` for admin broadcasts and errors, blue for joins and the startup
    /// greeting. Default body text uses the adaptive primary label color (black in light mode,
    /// white in dark mode) rather than a hardcoded black, so it stays legible in either appearance.
    var color: Color {
        switch self {
        case .purple: return Color(red: 128 / 255, green: 0, blue: 128 / 255)
        case .red: return Color(red: 192 / 255, green: 0, blue: 0)
        case .blue: return .blue
        case .primary: return .primary
        }
    }
}
