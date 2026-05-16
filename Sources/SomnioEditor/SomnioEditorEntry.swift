import Logging
import SomnioCore
import Sparkle
import SwiftUI

/// `@main` shim. Cannot live in a file literally named `main.swift` (SwiftPM treats
/// those as top-level entry points and `@main` is forbidden). The editor declares a
/// document-based `DocumentGroup` for `SectorDocument` plus a `Settings` scene; the
/// `Commands` builders register the Grid command, the Save/Import/Export file menu,
/// Sparkle's "Check for Updates...", and the About sheet.
@main
struct SomnioEditorEntry: App {
    private let updaterController: SPUStandardUpdaterController
    @FocusedValue(\.editorWorkspace) private var focused

    init() {
        LoggingConfiguration.bootstrap()
        let lifecycleLog = Logger(label: "de.tobiha.somnio.editor.lifecycle")
        lifecycleLog.info("SomnioEditor launching")
        self.updaterController = SPUStandardUpdaterController(
            startingUpdater: true,
            updaterDelegate: nil,
            userDriverDelegate: nil
        )
    }

    var body: some Scene {
        DocumentGroup(newDocument: { SectorDocument() }, editor: { configuration in
            SectorWindowView(document: configuration.document)
        })
        .commands {
            CommandGroup(replacing: .appInfo) {
                Button {
                    focused?.workspace.presentedSheet = .about
                } label: {
                    Text(L.resource("About Somnio Editor"))
                }
                .disabled(focused == nil)
            }
            CommandGroup(after: .appSettings) {
                Button {
                    updaterController.checkForUpdates(nil)
                } label: {
                    Text(L.resource("Check for Updates..."))
                }
            }
            EditorCommands()
            EditorFileCommands()
        }

        Settings {
            EditorPreferencesView()
        }
    }
}
