import SwiftUI

/// "About Somnio" sheet, mirroring the legacy `AboutFenster` four-control layout:
/// banner, version, copyright, thanks paragraph. Version is sourced from the bundle's
/// `CFBundleShortVersionString` rather than the catalog.
@MainActor struct AboutView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .center, spacing: 12) {
            Text(L.resource("Somnio"))
                .font(.largeTitle)
                .bold()
            Text(verbatim: String(format: L.string("Version: %@"), versionString))
            Text(L.resource("Copyright"))
                .font(.caption)
            Text(L.resource("Thanks paragraph"))
                .font(.caption)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: 360)
            Button {
                dismiss()
            } label: {
                Text(L.resource("OK"))
            }
            .keyboardShortcut(.defaultAction)
        }
        .padding(20)
        .frame(width: 400)
    }

    private var versionString: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    }
}
