import AppKit
import SomnioCore
import SomnioScene3D
import SwiftUI

/// Per-document main window. Hosts the 3D authoring canvas, the 2×4 placement palette,
/// the X/Y/W/H readouts, the sheet dispatch surface, and the .focusedSceneValue
/// injection that lets the top-level `.commands { ... }` builder route Grid, Save,
/// Import, and Export actions back to the focused document.
@MainActor struct SectorWindowView: View {
    @ObservedObject var document: SectorDocument
    @Environment(\.undoManager) private var undoManager

    var body: some View {
        let workspace = SectorWorkspaceRegistry.workspace(forID: document.id)
        @Bindable var bindable = workspace
        return EditorMainSurface(document: document, workspace: workspace)
            .focusedSceneValue(\.editorWorkspace, EditorWorkspaceFocusValue(document: document, workspace: workspace))
            .sheet(item: $bindable.presentedSheet) { kind in
                switch kind {
                case .newMap:
                    NewMapDialogView(document: document, workspace: workspace)
                case .objectDialog:
                    ObjectDialogView(document: document, workspace: workspace)
                case .maskDialog:
                    MaskDialogView(document: document, workspace: workspace)
                case .portalDialog:
                    PortalDialogView(document: document, workspace: workspace)
                case .spawnDialog:
                    SpawnDialogView(document: document, workspace: workspace)
                case .about:
                    AboutSheetView()
                }
            }
            .onAppear {
                if !workspace.didCompleteInitialSetup, document.isUninitialized {
                    workspace.presentedSheet = .newMap
                } else if !workspace.didCompleteInitialSetup {
                    // Opening an existing file leaves the scene in its splash state
                    // until the first mutation triggers `reconcile`; force the initial
                    // load here so the canvas renders the document's geometry on open.
                    workspace.reconcile(with: document.body, sectorName: document.sectorName)
                    workspace.didCompleteInitialSetup = true
                }
            }
            .onChange(of: workspace.selection) { _, newValue in
                workspace.cursorReadout.applyBounds(for: newValue, in: document.body)
                workspace.refreshOverlay(with: document.body)
            }
            .onChange(of: workspace.showGridOverlay) { _, _ in
                workspace.refreshOverlay(with: document.body)
            }
            // Focusable so Delete/Backspace routes to `onDeleteCommand`, but suppress the blue
            // focus ring SwiftUI would otherwise draw around the whole editor surface.
            .focusable(true)
            .focusEffectDisabled()
            .onDeleteCommand {
                CanvasController.deleteSelection(document: document, workspace: workspace, undoManager: undoManager)
            }
    }
}

@MainActor struct EditorMainSurface: View {
    let document: SectorDocument
    @Bindable var workspace: SectorWorkspace

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(spacing: 8) {
                canvas
                hudStrip
            }
            palette
        }
        .padding(12)
        .frame(minWidth: 820, minHeight: 540)
    }

    private var canvas: some View {
        // The orthographic camera frames the whole sector (including object footprints past
        // the sector edge), so the 3D viewport fills the available space instead of scrolling
        // a full-pixel canvas. Render, framing, and picking must all read the same live size,
        // so the GeometryReader size drives the view frame AND `workspace.viewportSize` —
        // `CanvasController.handleTap` unprojects through that shared framing.
        GeometryReader { proxy in
            ZStack {
                WorldScene3DView(scene: workspace.worldScene, size: proxy.size)
                CanvasScrollMonitor { event in
                    handleScroll(event)
                }
                Color.clear
                    .contentShape(Rectangle())
                    .onTapGesture(coordinateSpace: .local) { location in
                        CanvasController.handleTap(at: location, document: document, workspace: workspace)
                    }
                    .onContinuousHover(coordinateSpace: .local) { phase in
                        switch phase {
                        case let .active(point):
                            let grid = CanvasController.gridPoint(
                                forViewport: point,
                                viewportSize: workspace.viewportSize,
                                framing: workspace.framing
                            )
                            workspace.cursorReadout.x = grid.x
                            workspace.cursorReadout.y = grid.y
                        case .ended:
                            workspace.cursorReadout.x = 0
                            workspace.cursorReadout.y = 0
                        }
                    }
            }
            .onChange(of: proxy.size, initial: true) { _, newSize in
                workspace.updateViewportSize(newSize, body: document.body)
            }
        }
        .frame(minWidth: 640, maxWidth: .infinity, minHeight: 480, maxHeight: .infinity)
        .border(.secondary)
    }

    /// Canvas navigation: scroll pans (trackpads pan both axes; Shift turns a mouse wheel's
    /// vertical ticks horizontal) and ⌘-scroll zooms toward the game's default close-up.
    private func handleScroll(_ event: NSEvent) {
        let intent = CanvasController.scrollIntent(
            deltaX: event.scrollingDeltaX,
            deltaY: event.scrollingDeltaY,
            hasPreciseDeltas: event.hasPreciseScrollingDeltas,
            commandHeld: event.modifierFlags.contains(.command),
            shiftHeld: event.modifierFlags.contains(.shift)
        )
        switch intent {
        case let .zoom(deltaY):
            workspace.zoomCanvas(byScrollDeltaY: deltaY, body: document.body)
        case let .pan(delta):
            workspace.panCanvas(byViewportDelta: delta, body: document.body)
        }
    }

    private var hudStrip: some View {
        HStack(spacing: 16) {
            Text(verbatim: "X: \(workspace.cursorReadout.x)")
            Text(verbatim: "Y: \(workspace.cursorReadout.y)")
            Text(verbatim: "W: \(workspace.cursorReadout.width)")
            Text(verbatim: "H: \(workspace.cursorReadout.height)")
            Spacer()
        }
        .font(.system(.body, design: .monospaced))
        .frame(maxWidth: 640, alignment: .leading)
    }

    private var palette: some View {
        Grid(horizontalSpacing: 8, verticalSpacing: 8) {
            ForEach(EditorPlacementMode.allCases) { mode in
                GridRow {
                    paletteButton(slot: .selectAndEdit(mode), title: placementTitle(for: mode))
                    paletteButton(slot: .placeNew(mode), title: placementTitle(for: mode))
                }
            }
        }
        .frame(width: 160)
    }

    private func paletteButton(slot: PaletteSlot, title: LocalizedStringResource) -> some View {
        let isSelected = workspace.selectedPaletteSlot == slot
        return Button {
            workspace.selectedPaletteSlot = slot
            workspace.placementMode = slot.mode
        } label: {
            Text(title)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .tint(isSelected ? .accentColor : .secondary)
    }

    private func placementTitle(for mode: EditorPlacementMode) -> LocalizedStringResource {
        switch mode {
        case .object: return L.resource("Object")
        case .mask: return L.resource("Mask")
        case .portal: return L.resource("Sector portal")
        case .spawn: return L.resource("Spawn")
        }
    }
}
