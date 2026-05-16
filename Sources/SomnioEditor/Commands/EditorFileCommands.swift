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
/// while the document is uninitialized so an empty New-map sheet cannot Save to disk.
///
/// Import / Export form the bare-name file pair the server's on-disk convention
/// requires: the canonical document type is `.somnio-sector`, but operators copy bytes
/// to and from `Server/Maps/<Name>` (no extension) through these two menu items.
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
        panel.allowedContentTypes = [.data]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.treatsFilePackagesAsDirectories = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let data = try Data(contentsOf: url)
            let parsed = try SectorDocument.snapshot(from: data)
            let derivedName = url.deletingPathExtension().lastPathComponent
            let undoManager = focused.document.undoManager
            focused.document.renameSector(to: derivedName, undoManager: undoManager)
            focused.document.mutate("Create new map", undoManager: undoManager) { body in
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
        panel.allowedContentTypes = [.data]
        panel.allowsOtherFileTypes = true
        panel.nameFieldStringValue = focused.document.sectorName
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let data = try SectorDocument.data(for: focused.document.body)
            try data.write(to: url, options: .atomic)
        } catch {
            logger.error("export failed", metadata: ["error": "\(error)", "url": "\(url.path)"])
        }
    }
}

private extension SectorDocument {
    /// Inferred `UndoManager` for command-handler dispatch. `@FocusedValue` carries the
    /// focused document but not its window's undo manager, and the command builder
    /// can't read `@Environment(\.undoManager)`. The document does not own one
    /// directly under `ReferenceFileDocument`; returning `nil` is acceptable for the
    /// rare Import path where the user is replacing the entire body — Save is
    /// `isUninitialized`-gated immediately afterward, so the undo coverage gap is
    /// limited to "undo the Import sheet itself," which the user can recover from
    /// by closing and reopening the source file.
    var undoManager: UndoManager? {
        nil
    }
}
