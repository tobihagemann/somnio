import SomnioCore
import SwiftUI

/// Preferences pane delivered through the SwiftUI `Settings` scene. The legacy
/// `PrefsFenster` is empty; this port surfaces the only pref the codebase reads today
/// (`advancedLogLevel`) and a debug-build-only display of the resolved `SOMNIO_SERVER_URL`.
@MainActor struct PreferencesView: View {
    @State private var logLevel: String = Self.currentLogLevel

    private static let logLevelKey = "advancedLogLevel"

    init() {}

    var body: some View {
        Form {
            Section(header: Text(L.resource("Log level"))) {
                Picker(selection: $logLevel) {
                    Text(L.resource("Default")).tag("default")
                    Text(L.resource("Debug")).tag("debug")
                    Text(L.resource("Verbose")).tag("verbose")
                } label: {
                    Text(L.resource("Log level"))
                }
                .onChange(of: logLevel) { _, newValue in
                    let defaults = UserDefaults(suiteName: BuildEnvironment.userDefaultsSuiteName) ?? .standard
                    defaults.set(newValue, forKey: Self.logLevelKey)
                }
            }
            #if DEBUG
                Section(header: Text(L.resource("Server URL"))) {
                    Text(verbatim: resolvedServerURL)
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                }
            #endif
        }
        .padding(20)
        .frame(width: 360, height: 200)
    }

    private var resolvedServerURL: String {
        (try? GameplayURLResolver.resolve()) ?? ""
    }

    private static var currentLogLevel: String {
        let defaults = UserDefaults(suiteName: BuildEnvironment.userDefaultsSuiteName) ?? .standard
        return defaults.string(forKey: logLevelKey) ?? "default"
    }
}
