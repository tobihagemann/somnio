import SwiftUI

/// Shared colors for content sitting on the theme's dark plates, where the legacy
/// light-background hues vanish.
public enum FantasyPalette {
    /// Brightened error/admin red, shared by the chat palette and inline form errors.
    public static let errorRed = Color(red: 1, green: 110 / 255, blue: 110 / 255)
    /// De-emphasized captions and footers.
    public static let secondaryText = Color.white.opacity(0.7)
}
