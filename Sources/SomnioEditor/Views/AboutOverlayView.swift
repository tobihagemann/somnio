import SomnioTheme
import SwiftUI

/// "About Somnio Editor" overlay, mirroring the player client's About layout on the same
/// Fantasy chrome: title, version, copyright, thanks paragraph. Version is sourced from
/// the bundle's `CFBundleShortVersionString` rather than the catalog. OK (and Esc) back
/// out to the game menu.
@MainActor struct AboutOverlayView: View {
    let workspace: SectorWorkspace

    var body: some View {
        FantasyPanel {
            VStack(alignment: .center, spacing: 12) {
                FantasyFlankedLabel {
                    Text(L.resource("Somnio Editor"))
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
                Button {
                    workspace.presentedOverlay = .gameMenu
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
