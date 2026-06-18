import SomnioCore
import SomnioUI
import SwiftUI

/// Per-document main window. Hosts the SpriteKit canvas, the 2×4 placement palette,
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
                    // Opening an existing file leaves the WorldScene in its splash state
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
        // Full sector size plus a margin inside a scroll view, so large sectors and sprites that
        // overflow a sector edge (negative coords, or art taller than the footprint) stay reachable
        // instead of clipped. `CanvasController.gridCoordinate` undoes the margin to recover grid
        // coordinates from a `.local` point.
        let tile = CGFloat(SomnioConstants.tileSize)
        let sectorWidth = CGFloat(document.body.pixelWidth)
        let sectorHeight = CGFloat(document.body.pixelHeight)
        let margin = Self.canvasMargin(for: document.body, sectorWidth: sectorWidth, sectorHeight: sectorHeight, tile: tile)
        let contentSize = CGSize(
            width: max(sectorWidth + margin * 2, 1),
            height: max(sectorHeight + margin * 2, 1)
        )
        return ScrollView([.horizontal, .vertical]) {
            ZStack(alignment: .topLeading) {
                WorldSceneView(scene: workspace.worldScene, size: contentSize)
                Color.clear
                    .contentShape(Rectangle())
                    .frame(width: contentSize.width, height: contentSize.height)
                    .onTapGesture(coordinateSpace: .local) { location in
                        CanvasController.handleTap(at: location, margin: margin, document: document, workspace: workspace)
                    }
                    .onContinuousHover(coordinateSpace: .local) { phase in
                        switch phase {
                        case let .active(point):
                            workspace.cursorReadout.x = CanvasController.gridCoordinate(forLocal: point.x, margin: margin)
                            workspace.cursorReadout.y = CanvasController.gridCoordinate(forLocal: point.y, margin: margin)
                        case .ended:
                            workspace.cursorReadout.x = 0
                            workspace.cursorReadout.y = 0
                        }
                    }
            }
            .frame(width: contentSize.width, height: contentSize.height)
        }
        .frame(minWidth: 640, maxWidth: .infinity, minHeight: 480, maxHeight: .infinity)
        .border(.secondary)
    }

    /// Scrollable breathing room around the sector: at least one tile, expanded to cover any object
    /// sprite that extends past a sector edge so it stays visible and selectable in the editor.
    private static func canvasMargin(for body: SectorBody, sectorWidth: CGFloat, sectorHeight: CGFloat, tile: CGFloat) -> CGFloat {
        var overflow: CGFloat = 0
        for object in body.objects {
            let x = CGFloat(object.x)
            let y = CGFloat(object.y)
            let width = CGFloat(object.sourceWidth)
            let height = CGFloat(object.sourceHeight)
            overflow = max(overflow, -x, x + width - sectorWidth, -y, y + height - sectorHeight)
        }
        return max(tile, overflow.rounded(.up))
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
