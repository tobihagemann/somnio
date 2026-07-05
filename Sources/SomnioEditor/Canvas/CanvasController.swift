import CoreGraphics
import Foundation
import simd
import SomnioCore
import SomnioScene3D
import SwiftUI

/// Stateless dispatcher for canvas click + delete actions. Lives in the canvas layer
/// so the view body stays focused on layout and `.gesture`/`.onDeleteCommand` wiring.
@MainActor public enum CanvasController {
    /// Routes a canvas tap to either record selection (when the current palette slot
    /// is `.selectAndEdit`) or to the matching per-tool dialog (when `.placeNew`).
    /// The 3D canvas frames the sector through the workspace's shared camera framing, so the
    /// SwiftUI top-left `.local` point unprojects onto the floor plane to a legacy top-left
    /// grid coordinate, then quantizes.
    public static func handleTap(
        at location: CGPoint,
        document: SectorDocument,
        workspace: SectorWorkspace
    ) {
        let step = EditorDefaults.currentGridStepPx()
        let grid = gridPoint(forViewport: location, viewportSize: workspace.viewportSize, framing: workspace.framing)
        let point = GridPoint(
            x: EditorDefaults.quantize(grid.x, step: step),
            y: EditorDefaults.quantize(grid.y, step: step)
        )
        switch workspace.selectedPaletteSlot {
        case .selectAndEdit:
            workspace.selection = selectRecord(at: point, in: document.body, mode: workspace.placementMode)
        case .placeNew:
            workspace.selection = nil
            switch workspace.placementMode {
            case .object:
                workspace.objectForm.reset(at: point)
                workspace.presentedSheet = .objectDialog
            case .mask:
                workspace.maskForm.reset(at: point)
                workspace.presentedSheet = .maskDialog
            case .portal:
                workspace.portalForm.reset(at: point)
                workspace.presentedSheet = .portalDialog
            case .spawn:
                workspace.spawnForm.reset(at: point)
                workspace.presentedSheet = .spawnDialog
            }
        }
    }

    /// Converts a SwiftUI top-left `.local` viewport point to a legacy top-left grid
    /// coordinate: unproject through the shared camera framing onto the floor plane, then
    /// floor each axis into `Int16` (the same downward rounding the 2D pixel canvas used).
    public static func gridPoint(forViewport location: CGPoint, viewportSize: CGSize, framing: EditorFraming) -> GridPoint {
        let pixel = OrthographicCameraRig.legacyPoint(
            forViewport: SIMD2<Float>(location),
            viewportSize: SIMD2<Float>(viewportSize),
            framing: framing
        )
        return GridPoint(
            x: Int16(clamping: Int(pixel.x.rounded(.down))),
            y: Int16(clamping: Int(pixel.y.rounded(.down)))
        )
    }

    /// Navigation action a canvas scroll event resolves to.
    public enum ScrollIntent: Equatable {
        case zoom(deltaY: CGFloat)
        case pan(delta: CGSize)
    }

    /// Routes a scroll event's primitives to a navigation intent: ⌘ zooms, Shift turns a
    /// mouse wheel's vertical ticks horizontal, and line-based (non-precise) deltas are
    /// scaled up so one tick moves a readable distance.
    public static func scrollIntent(
        deltaX: CGFloat,
        deltaY: CGFloat,
        hasPreciseDeltas: Bool,
        commandHeld: Bool,
        shiftHeld: Bool
    ) -> ScrollIntent {
        let lineScale: CGFloat = hasPreciseDeltas ? 1 : 10
        if commandHeld {
            return .zoom(deltaY: deltaY * lineScale)
        }
        var delta = CGSize(width: deltaX * lineScale, height: deltaY * lineScale)
        if shiftHeld, delta.width == 0 {
            delta = CGSize(width: delta.height, height: 0)
        }
        return .pan(delta: delta)
    }

    public static func deleteSelection(
        document: SectorDocument,
        workspace: SectorWorkspace,
        undoManager: UndoManager?
    ) {
        guard let selection = workspace.selection else { return }
        document.mutate("Delete selection", undoManager: undoManager) { body in
            selection.remove(from: &body)
        }
        workspace.selection = nil
    }

    private static func selectRecord(at point: GridPoint, in body: SectorBody, mode: EditorPlacementMode) -> EditorSelection? {
        // Iterate in the order returned by `candidateSelections`; within each kind walk
        // back-to-front so the most-recently-placed record wins overlaps, matching the
        // legacy editor's selection preference.
        for selection in candidateSelections(in: body, mode: mode) {
            guard let (origin, size) = selection.bounds(in: body) else { continue }
            if contains(point: point, origin: origin, size: size) {
                return selection
            }
        }
        return nil
    }

    private static func candidateSelections(in body: SectorBody, mode: EditorPlacementMode) -> [EditorSelection] {
        switch mode {
        case .object: return body.objects.indices.reversed().map(EditorSelection.object)
        case .mask: return body.collisionMasks.indices.reversed().map(EditorSelection.mask)
        case .portal: return body.portals.indices.reversed().map(EditorSelection.portal)
        case .spawn:
            // NPCs come first so they win when overlapping a monster spawn (original
            // editor's tool order). Each kind is walked back-to-front so the latest
            // record wins within its own list.
            let npcs = body.npcs.indices.reversed().map(EditorSelection.npc)
            let monsters = body.monsterSpawns.indices.reversed().map(EditorSelection.monsterSpawn)
            return npcs + monsters
        }
    }

    private static func contains(point: GridPoint, origin: GridPoint, size: GridSize) -> Bool {
        let px = Int32(point.x)
        let py = Int32(point.y)
        let ox = Int32(origin.x)
        let oy = Int32(origin.y)
        let w = Int32(size.width)
        let h = Int32(size.height)
        return px >= ox && px < ox + w && py >= oy && py < oy + h
    }
}
