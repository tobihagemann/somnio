import CoreGraphics
import Foundation
import simd
import SomnioCore
import SomnioScene3D
import SwiftUI

/// Stateless canvas geometry + pick dispatcher. The drag interaction layer
/// (`DragController`) builds its sessions on these primitives; the view body stays
/// focused on layout and gesture wiring.
@MainActor public enum CanvasController {
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
    /// mouse wheel's vertical ticks horizontal, and line-based (non-precise) pan deltas are
    /// scaled up so one tick moves a readable distance. Zoom deltas stay raw — they feed
    /// the game's own `PlayerZoom`, whose gain is tuned against raw scroll deltas.
    public static func scrollIntent(
        deltaX: CGFloat,
        deltaY: CGFloat,
        hasPreciseDeltas: Bool,
        commandHeld: Bool,
        shiftHeld: Bool
    ) -> ScrollIntent {
        if commandHeld {
            return .zoom(deltaY: deltaY)
        }
        let lineScale: CGFloat = hasPreciseDeltas ? 1 : 10
        var delta = CGSize(width: deltaX * lineScale, height: deltaY * lineScale)
        if shiftHeld, delta.width == 0 {
            delta = CGSize(width: delta.height, height: 0)
        }
        return .pan(delta: delta)
    }

    /// Deletes every selected record in one undo step (descending-index removal per kind,
    /// see `EditorSelection.removeAll`). No-ops while a modal overlay is presented —
    /// `FantasyModalHost` swallows pointer input only, so the canvas command handlers
    /// stay wired underneath it.
    public static func deleteSelection(
        document: SectorDocument,
        workspace: SectorWorkspace,
        undoManager: UndoManager?
    ) {
        guard workspace.presentedOverlay == nil, !workspace.selection.isEmpty else { return }
        let selections = workspace.selection
        document.mutate("Delete selection", undoManager: undoManager) { body in
            EditorSelection.removeAll(selections, from: &body)
        }
        workspace.selection = []
    }

    /// Legacy-axis delta an arrow-key nudge moves the selection by: 1 px, or the grid
    /// step (floored to 1) with Shift held. Non-arrow keys resolve to `nil` so the press
    /// stays unhandled.
    public static func nudgeDelta(key: KeyEquivalent, shiftHeld: Bool, gridStep: Int16) -> (dx: Int32, dy: Int32)? {
        let step: Int32 = shiftHeld ? Int32(max(1, gridStep)) : 1
        switch key {
        case .upArrow: return (dx: 0, dy: -step)
        case .downArrow: return (dx: 0, dy: step)
        case .leftArrow: return (dx: -step, dy: 0)
        case .rightArrow: return (dx: step, dy: 0)
        default: return nil
        }
    }

    static func selectRecord(at point: GridPoint, in body: SectorBody, tool: EditorTool) -> EditorSelection? {
        // Iterate in the order returned by `candidateSelections`; within each kind walk
        // back-to-front so the most-recently-placed record wins overlaps, matching the
        // legacy editor's selection preference.
        for selection in candidateSelections(in: body, tool: tool) {
            guard let (origin, size) = selection.bounds(in: body) else { continue }
            if contains(point: point, origin: origin, size: size) {
                return selection
            }
        }
        return nil
    }

    static func candidateSelections(in body: SectorBody, tool: EditorTool) -> [EditorSelection] {
        // NPCs come first so they win when overlapping a monster spawn (original editor's
        // tool order); the Select tool hit-tests every kind, small spawn boxes before the
        // larger portal/mask/object rects so they stay reachable under overlaps.
        let npcs = body.npcs.indices.reversed().map(EditorSelection.npc)
        let monsters = body.monsterSpawns.indices.reversed().map(EditorSelection.monsterSpawn)
        let portals = body.portals.indices.reversed().map(EditorSelection.portal)
        let masks = body.collisionMasks.indices.reversed().map(EditorSelection.mask)
        let objects = body.objects.indices.reversed().map(EditorSelection.object)
        switch tool {
        case .select: return npcs + monsters + portals + masks + objects
        case .object: return objects
        case .mask: return masks
        case .portal: return portals
        case .npc: return npcs
        case .monster: return monsters
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
