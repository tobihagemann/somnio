import Foundation
import Testing
@testable import SomnioEditor

/// The Esc state table on the workspace, mirroring the player client's `handleEscape`
/// coverage: overlays back out one level toward the game menu, a live selection clears,
/// live editing opens the menu, and the new-map overlay over an uninitialized document is
/// the floor Esc cannot dismiss.
@MainActor
struct SectorWorkspaceEscapeTests {
    @Test func `the new-map floor over an uninitialized document consumes Esc`() {
        let workspace = SectorWorkspace()
        workspace.presentedOverlay = .newMap
        workspace.handleEscape(documentIsUninitialized: true)
        #expect(workspace.presentedOverlay == .newMap)
    }

    @Test func `the new-map overlay over an initialized document backs out to the game menu`() {
        let workspace = SectorWorkspace()
        workspace.presentedOverlay = .newMap
        workspace.handleEscape(documentIsUninitialized: false)
        #expect(workspace.presentedOverlay == .gameMenu)
    }

    @Test(arguments: [EditorOverlayKind.sectorSettings, .about])
    func `secondary overlays back out to the game menu`(overlay: EditorOverlayKind) {
        let workspace = SectorWorkspace()
        workspace.presentedOverlay = overlay
        workspace.handleEscape(documentIsUninitialized: false)
        #expect(workspace.presentedOverlay == .gameMenu)
    }

    @Test func `the game menu dismisses back to the canvas`() {
        let workspace = SectorWorkspace()
        workspace.presentedOverlay = .gameMenu
        workspace.handleEscape(documentIsUninitialized: false)
        #expect(workspace.presentedOverlay == nil)
    }

    @Test func `a live selection clears before the game menu opens`() {
        let workspace = SectorWorkspace()
        workspace.selection = [.object(0)]
        workspace.handleEscape(documentIsUninitialized: false)
        #expect(workspace.selection.isEmpty)
        #expect(workspace.presentedOverlay == nil)
        workspace.handleEscape(documentIsUninitialized: false)
        #expect(workspace.presentedOverlay == .gameMenu)
    }
}
