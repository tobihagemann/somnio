import SomnioUI
import SwiftUI

/// The Esc game menu layered over live play: Resume / Options / Leave Game / About.
/// Leave Game is disabled until the player is attached; its `performLeave` returns to
/// the login overlay, which auto-presents whenever the player is not attached.
@MainActor struct GameMenuOverlayView: View {
    let viewModel: ClientViewModel

    var body: some View {
        FantasyPanel(title: L.resource("Somnio")) {
            VStack(spacing: 10) {
                menuButton(L.resource("Resume")) {
                    viewModel.presentedOverlay = nil
                }
                menuButton(L.resource("Options")) {
                    viewModel.presentedOverlay = .options
                }
                menuButton(L.resource("Leave Game")) {
                    viewModel.leaveGame()
                }
                .disabled(viewModel.connectionState != .attached)
                menuButton(L.resource("About Somnio")) {
                    viewModel.presentedOverlay = .about
                }
            }
        }
        .frame(width: 280)
    }

    private func menuButton(_ title: LocalizedStringResource, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(FantasyButtonStyle())
    }
}
