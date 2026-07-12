import SwiftUI

/// The in-scene modal shell shared by the player's and the editor's overlay hosts: a
/// dimmed backdrop that swallows clicks to the surface below, the presented overlay
/// centered on it, and the modal accessibility contract — VoiceOver navigation stays
/// inside the overlay (`.isModal`) and Esc is exposed as the standard accessibility
/// escape. Living here keeps the two clients from drifting on the dim, the
/// hit-blocking, or the accessibility traits.
public struct FantasyModalHost<Content: View>: View {
    private let onEscape: () -> Void
    private let content: Content

    public init(@ViewBuilder content: () -> Content, onEscape: @escaping () -> Void) {
        self.onEscape = onEscape
        self.content = content()
    }

    public var body: some View {
        ZStack {
            Color.black.opacity(0.5)
                .contentShape(Rectangle())
            content
        }
        .accessibilityAddTraits(.isModal)
        .accessibilityAction(.escape, onEscape)
    }
}
