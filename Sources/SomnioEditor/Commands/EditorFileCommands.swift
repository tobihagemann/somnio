import AppKit
import Foundation
import Logging
import SomnioCore
import SwiftUI
import UniformTypeIdentifiers

/// File-menu replacement. `CommandGroup(replacing: .saveItem)` wipes the entire default
/// group (Save / Save As / Duplicate / Revert), so each item is redeclared. The Save
/// pipeline routes through the standard AppKit selectors which `DocumentGroup`'s
/// internal NSDocument bridge listens for; `.disabled(saveDisabled)` gates the items
/// while the document is uninitialized so an unconfigured fresh document cannot Save to disk.
///
/// Import / Export copy a `.somnio-sector` file to and from the server's `SOMNIO_SECTORS_DIR`
/// directly, separate from the document's own Save location; both sides use the same canonical
/// extension and JSON bytes.
public struct EditorFileCommands: Commands {
    @FocusedValue(\.editorWorkspace) private var focused
    private let logger = Logger(label: "de.tobiha.somnio.editor.io")

    private var saveDisabled: Bool {
        focused?.document.isUninitialized ?? true
    }

    public init() {}

    public var body: some Commands {
        CommandGroup(replacing: .saveItem) {
            Button {
                NSApp.sendAction(#selector(NSDocument.save(_:)), to: nil, from: nil)
            } label: {
                Text(L.resource("Save"))
            }
            .keyboardShortcut("s", modifiers: [.command])
            .disabled(saveDisabled)

            Button {
                NSApp.sendAction(#selector(NSDocument.saveAs(_:)), to: nil, from: nil)
            } label: {
                Text(L.resource("Save As..."))
            }
            .keyboardShortcut("s", modifiers: [.command, .shift])
            .disabled(saveDisabled)

            Button {
                NSApp.sendAction(#selector(NSDocument.duplicate(_:)), to: nil, from: nil)
            } label: {
                Text(L.resource("Duplicate"))
            }
            .keyboardShortcut("s", modifiers: [.command, .option, .shift])
            .disabled(saveDisabled)

            Button {
                NSApp.sendAction(#selector(NSDocument.revertToSaved(_:)), to: nil, from: nil)
            } label: {
                Text(L.resource("Revert to Saved"))
            }
            .disabled(saveDisabled)
        }
        CommandGroup(replacing: .importExport) {
            Button {
                importFromServer()
            } label: {
                Text(L.resource("Import from server..."))
            }
            .keyboardShortcut("i", modifiers: [.command, .shift])

            Button {
                exportToServer()
            } label: {
                Text(L.resource("Export to server..."))
            }
            .keyboardShortcut("e", modifiers: [.command, .shift])
            .disabled(saveDisabled)
        }
    }

    private func importFromServer() {
        guard let focused else { return }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.somnioSector]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.treatsFilePackagesAsDirectories = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let data = try Data(contentsOf: url)
            let parsed = try SectorDocument.snapshot(from: data)
            let derivedName = url.deletingPathExtension().lastPathComponent
            focused.document.renameSector(to: derivedName, undoManager: focused.undoManager)
            focused.document.mutate("Create new map", undoManager: focused.undoManager) { body in
                body = parsed
            }
            focused.workspace.didCompleteInitialSetup = true
        } catch {
            logger.error("import failed", metadata: ["error": "\(error)", "url": "\(url.path)"])
        }
    }

    private func exportToServer() {
        guard let focused, !focused.document.isUninitialized else { return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.somnioSector]
        panel.nameFieldStringValue = "\(focused.document.sectorName).somnio-sector"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let data = try SectorDocument.data(for: focused.document.body)
            try data.write(to: url, options: .atomic)
        } catch {
            logger.error("export failed", metadata: ["error": "\(error)", "url": "\(url.path)"])
        }
    }
}
