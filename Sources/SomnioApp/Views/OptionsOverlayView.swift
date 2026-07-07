import SomnioCore
import SomnioUI
import SwiftUI

/// In-game Options overlay: the only pref the codebase reads today (`advancedLogLevel`)
/// and a debug-build-only display of the resolved `SOMNIO_SERVER_URL`. Carries its own
/// Close button; Close (and Esc) return to the game menu while attached, else to the
/// login overlay.
@MainActor struct OptionsOverlayView: View {
    let viewModel: ClientViewModel
    @State private var logLevel: LogLevelPreference = .current

    var body: some View {
        FantasyPanel(title: L.resource("Options")) {
            VStack(alignment: .leading, spacing: 12) {
                Picker(selection: $logLevel) {
                    ForEach(LogLevelPreference.allCases, id: \.self) { level in
                        Text(Self.label(for: level)).tag(level)
                    }
                } label: {
                    Text(L.resource("Log level"))
                }
                .onChange(of: logLevel) { _, newValue in
                    LogLevelPreference.persist(newValue)
                }
                #if DEBUG
                    VStack(alignment: .leading, spacing: 4) {
                        Text(L.resource("Server URL"))
                            .font(.caption)
                            .foregroundStyle(FantasyPalette.secondaryText)
                        Text(verbatim: resolvedServerURL)
                            .font(.system(.body, design: .monospaced))
                            .textSelection(.enabled)
                    }
                #endif
                HStack {
                    Spacer()
                    Button {
                        viewModel.dismissPresentedOverlay()
                    } label: {
                        Text(L.resource("Close"))
                    }
                    .buttonStyle(FantasyButtonStyle())
                    .keyboardShortcut(.defaultAction)
                }
            }
        }
        .frame(width: 380)
    }

    private var resolvedServerURL: String {
        (try? GameplayURLResolver.resolve()) ?? ""
    }

    private static func label(for level: LogLevelPreference) -> LocalizedStringResource {
        switch level {
        case .standard: return L.resource("Default")
        case .debug: return L.resource("Debug")
        case .verbose: return L.resource("Verbose")
        }
    }
}
