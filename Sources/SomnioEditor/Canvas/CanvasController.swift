import CoreGraphics
import Foundation
import SomnioCore
import SwiftUI

/// Stateless dispatcher for canvas click + delete actions. Lives in the canvas layer
/// so the view body stays focused on layout and `.gesture`/`.onDeleteCommand` wiring.
@MainActor public enum CanvasController {
    /// Routes a canvas tap to either record selection (when the current palette slot
    /// is `.selectAndEdit`) or to the matching per-tool dialog (when `.placeNew`).
    /// The canvas renders the sector at full pixel size with a sector-centered camera, inset by
    /// `margin` of scrollable breathing room, so the SwiftUI top-left `.local` point maps to legacy
    /// top-left grid coordinates by subtracting that margin, then clamping and quantizing.
    public static func handleTap(
        at location: CGPoint,
        margin: CGFloat,
        document: SectorDocument,
        workspace: SectorWorkspace
    ) {
        let step = EditorDefaults.currentGridStepPx()
        let gridX = gridCoordinate(forLocal: location.x, margin: margin)
        let gridY = gridCoordinate(forLocal: location.y, margin: margin)
        let snappedX = EditorDefaults.quantize(gridX, step: step)
        let snappedY = EditorDefaults.quantize(gridY, step: step)
        let point = GridPoint(x: snappedX, y: snappedY)
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

    /// Converts a SwiftUI top-left `.local` axis coordinate to a legacy top-left grid coordinate:
    /// the sector is inset by `margin` of scroll padding, so remove it, then floor into `Int16`.
    public static func gridCoordinate(forLocal value: CGFloat, margin: CGFloat) -> Int16 {
        Int16(clamping: Int((value - margin).rounded(.down)))
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
