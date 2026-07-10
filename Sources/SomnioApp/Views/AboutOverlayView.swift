import SomnioUI
import SwiftUI

/// "About Somnio" overlay, mirroring the legacy `AboutFenster` layout — banner, version,
/// copyright, thanks paragraph — plus the asset-pack credits (voluntary for the CC0
/// sources, required-by-courtesy for all). Version is sourced from the bundle's
/// `CFBundleShortVersionString` rather than the catalog. Close (and Esc) return to the
/// game menu while attached, else to the login overlay.
@MainActor struct AboutOverlayView: View {
    let viewModel: ClientViewModel

    var body: some View {
        FantasyPanel {
            VStack(alignment: .center, spacing: 12) {
                FantasyFlankedLabel {
                    Text(L.resource("Somnio"))
                        .font(.largeTitle)
                        .bold()
                }
                Text(verbatim: String(format: L.string("Version: %@"), versionString))
                Text(L.resource("Copyright"))
                    .font(.caption)
                Text(L.resource("Thanks paragraph"))
                    .font(.caption)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 360)
                FantasyDivider()
                VStack(alignment: .center, spacing: 2) {
                    Text(L.resource("3D characters and props by KayKit."))
                    Text(L.resource("Ghost model by Quaternius."))
                    Text(L.resource("Floor textures by ambientCG."))
                    Text(L.resource("UI borders by Kenney."))
                }
                .font(.caption)
                .foregroundStyle(FantasyPalette.secondaryText)
                Button {
                    viewModel.dismissPresentedOverlay()
                } label: {
                    Text(L.resource("OK"))
                }
                .buttonStyle(FantasyButtonStyle())
                .keyboardShortcut(.defaultAction)
            }
        }
        .frame(width: 440)
    }

    private var versionString: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    }
}
