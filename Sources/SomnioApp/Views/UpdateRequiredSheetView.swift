import SwiftUI

/// Blocking sheet shown when the server's advertised protocol version disagrees with the
/// client's `helloVersion`. The two skew directions call for different actions: a client
/// that is behind the server gets a one-click Sparkle "Check for Updates..."; a client
/// ahead of the server is told to retry once the deploy catches up. The view stays
/// Sparkle-free — the updater is reached only through `onCheckForUpdates`.
@MainActor struct UpdateRequiredSheetView: View {
    let viewModel: ClientViewModel
    let skew: VersionSkew
    let onCheckForUpdates: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L.resource("Update required"))
                .font(.headline)
            Text(Self.message(for: skew))
            HStack {
                Spacer()
                switch skew {
                case .clientOutdated:
                    Button {
                        viewModel.presentedSheet = .login
                    } label: {
                        Text(L.resource("OK"))
                    }
                    Button {
                        onCheckForUpdates()
                    } label: {
                        Text(L.resource("Check for Updates..."))
                    }
                    .keyboardShortcut(.defaultAction)
                case .serverOutdated:
                    Button {
                        viewModel.presentedSheet = .login
                    } label: {
                        Text(L.resource("Try Again"))
                    }
                    .keyboardShortcut(.defaultAction)
                }
            }
        }
        .padding(20)
        .frame(width: 360)
    }

    private static func message(for skew: VersionSkew) -> LocalizedStringResource {
        switch skew {
        case .clientOutdated: return L.resource("A newer version is available. Please update your client to keep playing.")
        case .serverOutdated: return L.resource("The server is being updated. Please try again in a few moments.")
        }
    }
}
