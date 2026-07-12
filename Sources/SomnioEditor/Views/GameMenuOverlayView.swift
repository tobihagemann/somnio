import AppKit
import SomnioTheme
import SwiftUI

/// The Esc menu layered over the canvas, mirroring the player client's game menu. Each
/// item mirrors a native action for in-scene reach — the native File menu stays the
/// authoritative surface. New Document opens a fresh document window (distinct from the
/// New Map overlay, which replaces the focused document's geometry in place); Open and
/// Save route through the standard AppKit document selectors so the panel and the
/// dirty-tracking machinery stay native. The unsaved-changes line stands in for the
/// title-bar edited dot that `.hiddenTitleBar` + fullscreen suppress.
@MainActor struct GameMenuOverlayView: View {
    @ObservedObject var document: SectorDocument
    let workspace: SectorWorkspace
    @Environment(\.newDocument) private var newDocument

    var body: some View {
        FantasyPanel(title: L.resource("Somnio Editor")) {
            VStack(spacing: 10) {
                menuButton(L.resource("Resume")) {
                    workspace.presentedOverlay = nil
                }
                menuButton(L.resource("New Document")) {
                    workspace.presentedOverlay = nil
                    newDocument { SectorDocument() }
                }
                menuButton(L.resource("Open...")) {
                    workspace.presentedOverlay = nil
                    NSApp.sendAction(#selector(NSDocumentController.openDocument(_:)), to: nil, from: nil)
                }
                menuButton(L.resource("Save")) {
                    workspace.presentedOverlay = nil
                    NSApp.sendAction(#selector(NSDocument.save(_:)), to: nil, from: nil)
                }
                .disabled(document.isUninitialized)
                menuButton(L.resource("Sector Settings")) {
                    workspace.presentedOverlay = .sectorSettings
                }
                .disabled(document.isUninitialized)
                SettingsLink {
                    Text(L.resource("Preferences..."))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(FantasyButtonStyle())
                menuButton(L.resource("About Somnio Editor")) {
                    workspace.presentedOverlay = .about
                }
                if isDocumentEdited {
                    Text(L.resource("Unsaved changes"))
                        .font(.caption)
                        .foregroundStyle(FantasyPalette.secondaryText)
                }
            }
        }
        .frame(width: 300)
    }

    private var isDocumentEdited: Bool {
        NSApp.keyWindow?.isDocumentEdited ?? false
    }

    private func menuButton(_ title: LocalizedStringResource, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(FantasyButtonStyle())
    }
}
