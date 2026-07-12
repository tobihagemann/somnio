import AppKit
import SomnioCore
import SomnioScene3D
import SomnioTheme
import SwiftUI
import UniformTypeIdentifiers

/// Per-document main window: an edge-to-edge 3D canvas with floating Fantasy-chrome
/// overlays (tool palette leading, live inspector trailing, coordinate readout bottom),
/// the in-scene overlay host, and the `.focusedSceneValue` injection that lets the
/// top-level `.commands { ... }` builder route Grid, Save, Import, Export, and Duplicate
/// actions back to the focused document.
@MainActor struct SectorWindowView: View {
    @ObservedObject var document: SectorDocument
    @Environment(\.undoManager) private var undoManager

    var body: some View {
        let workspace = SectorWorkspaceRegistry.workspace(forID: document.id)
        return EditorMainSurface(document: document, workspace: workspace)
            .focusedSceneValue(\.editorWorkspace, EditorWorkspaceFocusValue(
                document: document, workspace: workspace, undoManager: undoManager
            ))
            .onAppear {
                if !workspace.didCompleteInitialSetup, document.isUninitialized {
                    workspace.presentedOverlay = .newMap
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
    }
}

@MainActor struct EditorMainSurface: View {
    @ObservedObject var document: SectorDocument
    @Bindable var workspace: SectorWorkspace
    @Environment(\.undoManager) private var undoManager

    /// Start location of the gesture the current drag session belongs to; `nil` outside a
    /// drag. Compared against each change's `startLocation` to detect a fresh gesture,
    /// because a cancelled drag never reports `.onEnded`.
    @State private var activeDragStart: CGPoint?
    /// Panels the cursor currently hovers, so the scroll monitor passes wheel events
    /// through to them instead of panning the world (tracked as a set: a cursor sliding
    /// panel-to-panel can report the enter before the exit).
    @State private var hoveredPanels: Set<FloatingPanel> = []

    private enum FloatingPanel: Hashable {
        case palette
        case inspector
        case readout
    }

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                WorldScene3DView(scene: workspace.worldScene, size: proxy.size)
                CanvasScrollMonitor { event in
                    handleScroll(event)
                }
                interactionLayer
                marqueeOverlay
            }
            .onChange(of: proxy.size, initial: true) { _, newSize in
                workspace.updateViewportSize(newSize, body: document.body)
            }
        }
        .overlay(alignment: .topLeading) {
            ToolPaletteView(workspace: workspace)
                .padding(12)
                .onHover { setHovered(.palette, $0) }
        }
        .overlay(alignment: .topTrailing) {
            InspectorPanelView(document: document, workspace: workspace)
                .padding(12)
                .onHover { setHovered(.inspector, $0) }
        }
        .overlay(alignment: .bottomLeading) {
            statusReadout
                .padding(12)
                .onHover { setHovered(.readout, $0) }
        }
        .overlay {
            overlayHost
        }
        .background(EditorWindowConfigurator(onEscape: handleEscape))
        .frame(minWidth: 820, minHeight: 540)
    }

    // MARK: - Interaction layer

    /// The transparent full-canvas input surface: the drag gesture (place/select/move/
    /// resize/rotate/marquee), the hover readout, keyboard focus for Delete and the arrow
    /// nudge, and the Edit-menu copy/paste hooks. Sits under the floating panels, so panel
    /// clicks never reach the canvas.
    private var interactionLayer: some View {
        Color.clear
            .contentShape(Rectangle())
            .gesture(canvasDrag)
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
                    workspace.lastHoveredGrid = grid
                case .ended:
                    workspace.cursorReadout.x = 0
                    workspace.cursorReadout.y = 0
                }
            }
            // Focusable so Delete/arrows route here, but suppress the blue focus ring
            // SwiftUI would otherwise draw around the whole editor surface.
            .focusable(true)
            .focusEffectDisabled()
            .onDeleteCommand {
                CanvasController.deleteSelection(document: document, workspace: workspace, undoManager: undoManager)
            }
            .onKeyPress(keys: [.upArrow, .downArrow, .leftArrow, .rightArrow], phases: [.down, .repeat]) { press in
                nudgeSelection(press)
            }
            .onCopyCommand {
                copySelection()
            }
            .onPasteCommand(of: [.somnioEditorRecords]) { _ in
                pasteRecords()
            }
    }

    private var canvasDrag: some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .local)
            .onChanged { value in
                // A new gesture is one whose start point differs from the active session's
                // (or none is active). SwiftUI can cancel a drag without ever calling
                // `.onEnded`, so keying off the start location lets the next press discard
                // a stale session instead of silently continuing it.
                if activeDragStart != value.startLocation {
                    resetDragState()
                    activeDragStart = value.startLocation
                    let additive = NSEvent.modifierFlags.contains(.shift)
                    workspace.dragAdditive = additive
                    let begun = DragController.beginSession(
                        at: value.startLocation,
                        tool: workspace.tool,
                        additive: additive,
                        body: document.body,
                        selection: workspace.selection,
                        viewportSize: workspace.viewportSize,
                        framing: workspace.framing
                    )
                    workspace.dragSession = begun.session
                    if begun.selection != workspace.selection {
                        workspace.selection = begun.selection
                    }
                }
                guard let session = workspace.dragSession else { return }
                if case .marquee = session {
                    workspace.marqueeRect = Self.rect(from: value.startLocation, to: value.location)
                } else {
                    workspace.dragPreview = DragController.preview(
                        session: session,
                        start: value.startLocation,
                        current: value.location,
                        body: document.body,
                        viewportSize: workspace.viewportSize,
                        framing: workspace.framing
                    )
                    workspace.refreshOverlay(with: document.body)
                }
            }
            .onEnded { value in
                let session = workspace.dragSession
                let additive = workspace.dragAdditive
                resetDragState()
                guard let session else {
                    workspace.refreshOverlay(with: document.body)
                    return
                }
                DragController.endSession(
                    session,
                    start: value.startLocation,
                    end: value.location,
                    additive: additive,
                    document: document,
                    workspace: workspace,
                    undoManager: undoManager
                )
                workspace.refreshOverlay(with: document.body)
            }
    }

    /// Single home for ending a drag lifecycle, shared by the normal `.onEnded` path and
    /// the stale-session recovery at the start of a fresh gesture.
    private func resetDragState() {
        activeDragStart = nil
        workspace.dragSession = nil
        workspace.dragPreview = nil
        workspace.marqueeRect = nil
        workspace.dragAdditive = false
    }

    @ViewBuilder private var marqueeOverlay: some View {
        if let rect = workspace.marqueeRect {
            Rectangle()
                .fill(.yellow.opacity(0.15))
                .overlay {
                    Rectangle().stroke(.yellow, lineWidth: 1)
                }
                .frame(width: rect.width, height: rect.height)
                .position(x: rect.midX, y: rect.midY)
                .allowsHitTesting(false)
        }
    }

    private static func rect(from start: CGPoint, to end: CGPoint) -> CGRect {
        CGRect(
            x: min(start.x, end.x), y: min(start.y, end.y),
            width: abs(end.x - start.x), height: abs(end.y - start.y)
        )
    }

    // MARK: - Keyboard + clipboard

    private static let recordsPasteboardType = NSPasteboard.PasteboardType(UTType.somnioEditorRecords.identifier)

    /// Arrow keys nudge the whole selection by 1 px (Shift = the grid step), one undo step
    /// per press; deltas widen to `Int32` inside `applyMove` so nudging at the coordinate
    /// limits clamps instead of trapping. Ignored while a modal overlay is presented —
    /// the interaction layer keeps focus underneath `FantasyModalHost`.
    private func nudgeSelection(_ press: KeyPress) -> KeyPress.Result {
        guard workspace.presentedOverlay == nil, !workspace.selection.isEmpty else { return .ignored }
        guard let delta = CanvasController.nudgeDelta(
            key: press.key,
            shiftHeld: press.modifiers.contains(.shift),
            gridStep: EditorDefaults.currentGridStepPx()
        ) else { return .ignored }
        let originals = DragController.origins(of: workspace.selection, in: document.body)
        document.mutate("Move selection", undoManager: undoManager) { body in
            DragController.applyMove(originals: originals, dx: delta.dx, dy: delta.dy, to: &body)
        }
        return .handled
    }

    /// ⌘C via the standard Edit menu: the selection's record values ride the system
    /// pasteboard as JSON, so a focused text field keeps its own text copy and a second
    /// editor window can receive the records. The pasteboard is written directly —
    /// SwiftUI's provider→pasteboard bridge advertises our UTI but never materializes
    /// its bytes (the identifier isn't LaunchServices-registered, and both the lazy and
    /// the eager `NSItemProvider` forms came back empty), so `onCopyCommand` serves only
    /// as the Edit-menu trigger and the write happens after its dispatch turn.
    private func copySelection() -> [NSItemProvider] {
        guard workspace.presentedOverlay == nil else { return [] }
        let clipboard = EditorClipboard.capture(workspace.selection, from: document.body)
        guard !clipboard.isEmpty, let data = try? JSONEncoder().encode(clipboard) else { return [] }
        DispatchQueue.main.async {
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            pasteboard.setData(data, forType: Self.recordsPasteboardType)
        }
        return []
    }

    /// ⌘V: reads the pasteboard synchronously (the provider callback is not main-actor
    /// friendly) and appends the clones anchored at the last hovered grid point, selecting
    /// them.
    private func pasteRecords() {
        guard workspace.presentedOverlay == nil else { return }
        // The pasteboard is an untrusted boundary: `validatedPaste` bounds the bytes,
        // decodes, and accepts only a resulting body `MapCodec.write` round-trips, so a
        // hostile or oversized payload can't wedge the document into an unsavable state.
        guard let data = NSPasteboard.general.data(forType: Self.recordsPasteboardType),
              let pasted = EditorClipboard.validatedPaste(
                  data: data,
                  into: document.body,
                  anchor: workspace.lastHoveredGrid,
                  fallbackOffset: max(1, EditorDefaults.currentGridStepPx())
              )
        else { return }
        document.mutate("Paste", undoManager: undoManager) { body in
            body = pasted.body
        }
        workspace.selection = pasted.selection
    }

    // MARK: - Scroll + readout

    /// Canvas navigation: scroll pans (trackpads pan both axes; Shift turns a mouse wheel's
    /// vertical ticks horizontal) and ⌘-scroll zooms toward the game's default close-up.
    /// Wheel events pass through while an overlay is up or the cursor sits over a floating
    /// panel.
    private func handleScroll(_ event: NSEvent) -> Bool {
        guard workspace.presentedOverlay == nil, hoveredPanels.isEmpty else { return false }
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
        return true
    }

    private func setHovered(_ panel: FloatingPanel, _ hovering: Bool) {
        if hovering {
            hoveredPanels.insert(panel)
        } else {
            hoveredPanels.remove(panel)
        }
    }

    private var statusReadout: some View {
        FantasyPanel(fillOpacity: 0.6) {
            HStack(spacing: 16) {
                Text(verbatim: "X: \(workspace.cursorReadout.x)")
                Text(verbatim: "Y: \(workspace.cursorReadout.y)")
                Text(verbatim: "W: \(workspace.cursorReadout.width)")
                Text(verbatim: "H: \(workspace.cursorReadout.height)")
                if !document.sectorName.isEmpty {
                    Text(verbatim: document.sectorName)
                        .foregroundStyle(FantasyPalette.secondaryText)
                }
            }
            .font(.system(.body, design: .monospaced))
        }
    }

    // MARK: - Overlay host

    /// The in-scene modal stack: `FantasyModalHost` supplies the dimmed click-swallowing
    /// backdrop and the modal accessibility contract (the player client's composition);
    /// this switch supplies the overlay.
    @ViewBuilder private var overlayHost: some View {
        if let overlay = workspace.presentedOverlay {
            FantasyModalHost {
                switch overlay {
                case .gameMenu:
                    GameMenuOverlayView(document: document, workspace: workspace)
                case .newMap:
                    NewMapOverlayView(document: document, workspace: workspace)
                case .sectorSettings:
                    SectorSettingsOverlayView(document: document, workspace: workspace)
                case .about:
                    AboutOverlayView(workspace: workspace)
                }
            } onEscape: {
                handleEscape()
            }
        }
    }

    private func handleEscape() {
        workspace.handleEscape(documentIsUninitialized: document.isUninitialized)
    }
}
