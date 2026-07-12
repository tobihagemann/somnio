import Logging
import SomnioCore
import SwiftUI

/// `@main` shim. Cannot live in a file literally named `main.swift` (SwiftPM treats
/// those as top-level entry points and `@main` is forbidden). The editor declares a
/// document-based `DocumentGroup` for `SectorDocument` plus a `Settings` scene; the
/// `Commands` builders register the Grid/Duplicate commands, the Save/Import/Export
/// file menu, and the About overlay. Each document window is immersive — hidden title
/// bar, fullscreen-first via `EditorWindowConfigurator` — while keeping the native
/// document machinery (autosave, save-on-close prompts, Recent). The editor ships
/// without auto-update (it is built and distributed locally, not through the CI
/// release pipeline).
@main
struct SomnioEditorEntry: App {
    @FocusedValue(\.editorWorkspace) private var focused

    init() {
        LoggingConfiguration.bootstrap()
        let lifecycleLog = Logger(label: "de.tobiha.somnio.editor.lifecycle")
        lifecycleLog.info("SomnioEditor launching")
    }

    var body: some Scene {
        DocumentGroup(newDocument: { SectorDocument() }, editor: { configuration in
            SectorWindowView(document: configuration.document)
        })
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(replacing: .appInfo) {
                Button {
                    focused?.workspace.presentedOverlay = .about
                } label: {
                    Text(L.resource("About Somnio Editor"))
                }
                .disabled(focused == nil)
            }
            EditorCommands()
            EditorFileCommands()
        }

        Settings {
            EditorPreferencesView()
        }
    }
}
