import SomnioUI
import SwiftUI

/// Blocking overlay shown when the server's advertised protocol version disagrees with the
/// client's `helloVersion`. The two skew directions call for different actions: a client
/// that is behind the server gets a one-click Sparkle "Check for Updates..." (the one
/// unavoidable native window); a client ahead of the server is told to retry once the
/// deploy catches up. The view stays Sparkle-free — the updater is reached only through
/// `onCheckForUpdates`. Backing out (OK / Try Again / Esc) returns to the login overlay.
@MainActor struct UpdateRequiredOverlayView: View {
    let viewModel: ClientViewModel
    let skew: VersionSkew
    let onCheckForUpdates: () -> Void

    var body: some View {
        FantasyPanel(title: L.resource("Update required")) {
            VStack(alignment: .leading, spacing: 12) {
                Text(Self.message(for: skew))
                HStack {
                    Spacer()
                    switch skew {
                    case .clientOutdated:
                        Button {
                            viewModel.presentedOverlay = .login
                        } label: {
                            Text(L.resource("OK"))
                        }
                        .buttonStyle(FantasyButtonStyle())
                        Button {
                            onCheckForUpdates()
                        } label: {
                            Text(L.resource("Check for Updates..."))
                        }
                        .buttonStyle(FantasyButtonStyle())
                        .keyboardShortcut(.defaultAction)
                    case .serverOutdated:
                        Button {
                            viewModel.presentedOverlay = .login
                        } label: {
                            Text(L.resource("Try Again"))
                        }
                        .buttonStyle(FantasyButtonStyle())
                        .keyboardShortcut(.defaultAction)
                    }
                }
            }
        }
        .frame(width: 420)
    }

    private static func message(for skew: VersionSkew) -> LocalizedStringResource {
        switch skew {
        case .clientOutdated: return L.resource("A newer version is available. Please update your client to keep playing.")
        case .serverOutdated: return L.resource("The server is being updated. Please try again in a few moments.")
        }
    }
}
