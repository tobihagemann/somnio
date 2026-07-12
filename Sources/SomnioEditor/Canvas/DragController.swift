import CoreGraphics
import Foundation
import simd
import SomnioCore
import SomnioScene3D
import SwiftUI

/// One resize affordance on the selection bounds, named in legacy floor axes (top = north
/// edge, left = west edge). The tilted camera rotates these on screen, but the drag math
/// stays in floor space so a "left" handle always moves the record's west edge.
public enum EditorResizeHandle: CaseIterable, Sendable, Equatable {
    case topLeft, top, topRight
    case left, right
    case bottomLeft, bottom, bottomRight

    var movesLeftEdge: Bool {
        self == .topLeft || self == .left || self == .bottomLeft
    }

    var movesRightEdge: Bool {
        self == .topRight || self == .right || self == .bottomRight
    }

    var movesTopEdge: Bool {
        self == .topLeft || self == .top || self == .topRight
    }

    var movesBottomEdge: Bool {
        self == .bottomLeft || self == .bottom || self == .bottomRight
    }
}

/// In-flight canvas drag, classified once at the gesture's first change. Placement carries
/// its quantized press anchor; move snapshots every selected record's origin at press time
/// so the live delta always applies to the pre-drag geometry; resize snapshots the grabbed
/// record's bounds for the same reason.
public enum EditorDragSession: Equatable {
    case placement(tool: EditorTool, anchor: GridPoint)
    case move(originals: [EditorSelection: GridPoint])
    case resize(selection: EditorSelection, handle: EditorResizeHandle, origin: GridPoint, size: GridSize)
    case rotate(npcIndex: Int)
    case marquee
}

// The session/preview/commit/geometry entry points below take the full gesture +
// projection context (points, body, viewport, framing) — semantically distinct values
// that a bundling struct would only rename, so the parameter-count rule is lifted for
// this block (re-enabled after `resizedBounds`).
// swiftlint:disable function_parameter_count

/// Stateless drag interaction layer (mirroring `CanvasController`): resolves gesture points
/// into sessions, live previews, and committed mutations. All coordinate/size arithmetic
/// widens `Int16` grid values to `Int32` before applying user-controlled deltas and narrows
/// back with `Int16(clamping:)`, so a drag at the coordinate limits clamps instead of
/// trapping. Kept view-free so the geometry is unit-testable.
@MainActor enum DragController {
    /// Drawn extent of the resize/facing handles, in viewport points (converted to legacy
    /// pixels through the live framing so handles keep a constant screen size).
    static let handleDrawExtentPt: CGFloat = 8
    /// Hit-test extent around each handle center — larger than the drawn square so the
    /// grab target stays comfortable.
    static let handleHitExtentPt: CGFloat = 14
    /// Screen clearance between the NPC spawn box and its facing handle.
    static let facingClearancePt: CGFloat = 24
    /// A gesture travelling less than this is a tap: placement drops the default footprint
    /// instead of a rubber-band rect.
    static let tapTranslationThresholdPt: CGFloat = 4

    static let defaultFootprint = GridSize(width: SomnioConstants.tileSize, height: SomnioConstants.tileSize)

    // MARK: - Session classification

    /// Classifies a gesture's first change into a session, possibly retargeting the
    /// selection (pressing an unselected record selects it before moving; Shift-click on
    /// a record toggles membership and starts no session). Edit handles keep precedence
    /// over the Shift modifier — Shift+handle stays a resize/rotate grab, the mainstream
    /// editor convention.
    static func beginSession(
        at location: CGPoint,
        tool: EditorTool,
        additive: Bool,
        body: SectorBody,
        selection: Set<EditorSelection>,
        viewportSize: CGSize,
        framing: EditorFraming
    ) -> (session: EditorDragSession?, selection: Set<EditorSelection>) {
        guard tool == .select else {
            let step = EditorDefaults.currentGridStepPx()
            let grid = CanvasController.gridPoint(forViewport: location, viewportSize: viewportSize, framing: framing)
            let anchor = GridPoint(
                x: EditorDefaults.quantize(grid.x, step: step),
                y: EditorDefaults.quantize(grid.y, step: step)
            )
            return (.placement(tool: tool, anchor: anchor), selection)
        }

        if selection.count == 1, let selected = selection.first {
            if case let .npc(index) = selected, body.npcs.indices.contains(index) {
                let npc = body.npcs[index]
                let clearancePx = Float(facingClearancePt) * legacyPixelsPerViewportPoint(viewportSize: viewportSize, framing: framing)
                let handlePixel = facingHandlePixel(
                    origin: npc.spawnOrigin, size: npc.spawnBoxSize, heading: npc.facing, clearancePx: clearancePx
                )
                if handleHitRect(aroundPixel: handlePixel, viewportSize: viewportSize, framing: framing).contains(location) {
                    return (.rotate(npcIndex: index), selection)
                }
            }
            if let bounds = selected.bounds(in: body),
               let handle = hitHandle(at: location, origin: bounds.origin, size: bounds.size, viewportSize: viewportSize, framing: framing) {
                return (.resize(selection: selected, handle: handle, origin: bounds.origin, size: bounds.size), selection)
            }
        }

        let point = CanvasController.gridPoint(forViewport: location, viewportSize: viewportSize, framing: framing)
        if additive {
            guard let picked = CanvasController.selectRecord(at: point, in: body, tool: .select) else {
                return (.marquee, selection)
            }
            var toggled = selection
            if toggled.contains(picked) {
                toggled.remove(picked)
            } else {
                toggled.insert(picked)
            }
            return (nil, toggled)
        }
        // Resolve the topmost record at the point first: pressing a record that overlaps
        // the current selection must manipulate what is visibly under the cursor, so the
        // whole selection moves only when the winning pick is itself selected.
        guard let picked = CanvasController.selectRecord(at: point, in: body, tool: .select) else {
            return (.marquee, [])
        }
        if selection.contains(picked) {
            return (.move(originals: origins(of: selection, in: body)), selection)
        }
        let retargeted: Set<EditorSelection> = [picked]
        return (.move(originals: origins(of: retargeted, in: body)), retargeted)
    }

    // MARK: - Live preview

    /// The transient sector body a live drag should render, or `nil` when the session has
    /// no floor-space preview (marquee draws a viewport rect instead).
    static func preview(
        session: EditorDragSession,
        start: CGPoint,
        current: CGPoint,
        body: SectorBody,
        viewportSize: CGSize,
        framing: EditorFraming
    ) -> SectorBody? {
        let step = EditorDefaults.currentGridStepPx()
        switch session {
        case let .placement(tool, anchor):
            var preview = body
            let bounds = placementBounds(
                tool: tool, anchor: anchor, start: start, end: current,
                viewportSize: viewportSize, framing: framing, step: step
            )
            _ = placeRecord(tool: tool, origin: bounds.origin, size: bounds.size, into: &preview)
            return preview
        case let .move(originals):
            let delta = gridDelta(fromViewport: start, toViewport: current, viewportSize: viewportSize, framing: framing, step: step)
            var preview = body
            applyMove(originals: originals, dx: delta.dx, dy: delta.dy, to: &preview)
            return preview
        case let .resize(selection, handle, origin, size):
            let delta = gridDelta(fromViewport: start, toViewport: current, viewportSize: viewportSize, framing: framing, step: step)
            let bounds = resizedBounds(origin: origin, size: size, handle: handle, dx: delta.dx, dy: delta.dy, minExtent: Int32(max(1, step)))
            var preview = body
            applyBounds(selection, origin: bounds.origin, size: bounds.size, to: &preview)
            return preview
        case let .rotate(index):
            guard body.npcs.indices.contains(index) else { return nil }
            var preview = body
            preview.npcs[index].facing = heading(fromViewport: current, npc: preview.npcs[index], viewportSize: viewportSize, framing: framing)
            return preview
        case .marquee:
            return nil
        }
    }

    // MARK: - Commit

    /// Commits a finished drag: placement appends and selects the new record, move/resize/
    /// rotate write one `mutate` each (no-op when the drag came back to its origin — the
    /// click-selection already happened in `beginSession`), and marquee resolves the
    /// viewport rect into a selection set.
    static func endSession(
        _ session: EditorDragSession,
        start: CGPoint,
        end: CGPoint,
        additive: Bool,
        document: SectorDocument,
        workspace: SectorWorkspace,
        undoManager: UndoManager?
    ) {
        let viewportSize = workspace.viewportSize
        let framing = workspace.framing
        let step = EditorDefaults.currentGridStepPx()
        switch session {
        case let .placement(tool, anchor):
            let bounds = placementBounds(
                tool: tool, anchor: anchor, start: start, end: end,
                viewportSize: viewportSize, framing: framing, step: step
            )
            var placed: EditorSelection?
            document.mutate(placementDescription(for: tool), undoManager: undoManager) { body in
                placed = placeRecord(tool: tool, origin: bounds.origin, size: bounds.size, into: &body)
            }
            workspace.selection = placed.map { [$0] } ?? []
        case let .move(originals):
            let delta = gridDelta(fromViewport: start, toViewport: end, viewportSize: viewportSize, framing: framing, step: step)
            guard delta.dx != 0 || delta.dy != 0 else { return }
            document.mutate("Move selection", undoManager: undoManager) { body in
                applyMove(originals: originals, dx: delta.dx, dy: delta.dy, to: &body)
            }
        case let .resize(selection, handle, origin, size):
            let delta = gridDelta(fromViewport: start, toViewport: end, viewportSize: viewportSize, framing: framing, step: step)
            guard delta.dx != 0 || delta.dy != 0 else { return }
            let bounds = resizedBounds(origin: origin, size: size, handle: handle, dx: delta.dx, dy: delta.dy, minExtent: Int32(max(1, step)))
            document.mutate("Resize selection", undoManager: undoManager) { body in
                applyBounds(selection, origin: bounds.origin, size: bounds.size, to: &body)
            }
        case let .rotate(index):
            commitRotation(of: index, at: end, document: document, viewportSize: viewportSize, framing: framing, undoManager: undoManager)
        case .marquee:
            // A tap-sized marquee is just a click on empty ground: the deselection already
            // happened in `beginSession`, and a zero-size rect must not intersect-select
            // whatever record's projection happens to pass under the point.
            guard hypot(end.x - start.x, end.y - start.y) >= tapTranslationThresholdPt else { return }
            let rect = CGRect(
                x: min(start.x, end.x), y: min(start.y, end.y),
                width: abs(end.x - start.x), height: abs(end.y - start.y)
            )
            let hits = marqueeSelections(in: document.body, viewportRect: rect, viewportSize: viewportSize, framing: framing)
            workspace.selection = additive ? workspace.selection.union(hits) : hits
        }
    }

    /// Commits a finished facing drag. A grab that comes back to (essentially) the
    /// current heading is a no-op — committing it would register a do-nothing undo entry
    /// for every handle click.
    private static func commitRotation(
        of index: Int,
        at end: CGPoint,
        document: SectorDocument,
        viewportSize: CGSize,
        framing: EditorFraming,
        undoManager: UndoManager?
    ) {
        guard document.body.npcs.indices.contains(index) else { return }
        let npc = document.body.npcs[index]
        let facing = heading(fromViewport: end, npc: npc, viewportSize: viewportSize, framing: framing)
        guard abs(facing.angularDistance(to: npc.facing)) > 0.01 else { return }
        document.mutate("Rotate NPC", undoManager: undoManager) { body in
            guard body.npcs.indices.contains(index) else { return }
            body.npcs[index].facing = facing
        }
    }

    // MARK: - Geometry

    /// Legacy pixels covered by one viewport point at the given framing. The orthographic
    /// scale is the view volume's vertical HALF-height (see
    /// `OrthographicCameraRig.legacyPoint(forViewport:)`), so the viewport height spans
    /// `2 × scale` meters.
    static func legacyPixelsPerViewportPoint(viewportSize: CGSize, framing: EditorFraming) -> Float {
        guard viewportSize.height > 0 else { return 1 }
        return framing.scale * 2 / Float(viewportSize.height) / OrthographicCameraRig.worldUnitsPerPixel
    }

    /// Quantized grid delta between two viewport points, widened to `Int32`. Quantizing the
    /// delta (not the endpoints) keeps a group move's relative offsets intact.
    static func gridDelta(
        fromViewport start: CGPoint,
        toViewport end: CGPoint,
        viewportSize: CGSize,
        framing: EditorFraming,
        step: Int16
    ) -> (dx: Int32, dy: Int32) {
        let viewport = SIMD2<Float>(viewportSize)
        let from = OrthographicCameraRig.legacyPoint(forViewport: SIMD2<Float>(start), viewportSize: viewport, framing: framing)
        let to = OrthographicCameraRig.legacyPoint(forViewport: SIMD2<Float>(end), viewportSize: viewport, framing: framing)
        let rawX = Int32((to.x - from.x).rounded())
        let rawY = Int32((to.y - from.y).rounded())
        let stride = Int32(step)
        guard stride > 0 else { return (rawX, rawY) }
        return ((rawX / stride) * stride, (rawY / stride) * stride)
    }

    /// Bounds a placement drag resolves to: a tap (or an NPC/monster press, whose spawn box
    /// is refined in the inspector) drops the default one-tile footprint at the anchor; a
    /// rubber-band drag spans anchor→end, at least one snap step per axis.
    static func placementBounds(
        tool: EditorTool,
        anchor: GridPoint,
        start: CGPoint,
        end: CGPoint,
        viewportSize: CGSize,
        framing: EditorFraming,
        step: Int16
    ) -> (origin: GridPoint, size: GridSize) {
        let translation = hypot(end.x - start.x, end.y - start.y)
        switch tool {
        case .select, .npc, .monster:
            return (anchor, defaultFootprint)
        case .object, .mask, .portal:
            guard translation >= tapTranslationThresholdPt else { return (anchor, defaultFootprint) }
            let grid = CanvasController.gridPoint(forViewport: end, viewportSize: viewportSize, framing: framing)
            let far = GridPoint(
                x: EditorDefaults.quantize(grid.x, step: step),
                y: EditorDefaults.quantize(grid.y, step: step)
            )
            return rubberBandBounds(from: anchor, to: far, minExtent: Int32(max(1, step)))
        }
    }

    /// Normalized rect between two quantized grid points, at least `minExtent` per axis.
    static func rubberBandBounds(from anchor: GridPoint, to point: GridPoint, minExtent: Int32) -> (origin: GridPoint, size: GridSize) {
        let minX = min(Int32(anchor.x), Int32(point.x))
        let minY = min(Int32(anchor.y), Int32(point.y))
        let width = max(abs(Int32(point.x) - Int32(anchor.x)), minExtent)
        let height = max(abs(Int32(point.y) - Int32(anchor.y)), minExtent)
        return (
            GridPoint(x: Int16(clamping: minX), y: Int16(clamping: minY)),
            GridSize(width: Int16(clamping: width), height: Int16(clamping: height))
        )
    }

    /// Bounds after dragging one handle by a quantized delta. Each grabbed edge moves;
    /// the opposite edge stays fixed, and the moved edge clamps at `minExtent` from it so
    /// the record can never invert or vanish.
    static func resizedBounds(
        origin: GridPoint,
        size: GridSize,
        handle: EditorResizeHandle,
        dx: Int32,
        dy: Int32,
        minExtent: Int32
    ) -> (origin: GridPoint, size: GridSize) {
        var minX = Int32(origin.x)
        var minY = Int32(origin.y)
        var maxX = minX + Int32(size.width)
        var maxY = minY + Int32(size.height)
        // The moved edge clamps into the `Int16` domain (and to a representable extent)
        // BEFORE the extent is derived — clamping origin and size independently at return
        // would shift the supposedly fixed opposite edge when a drag runs past the limits.
        // The minimum-extent floor is re-applied last: a record whose fixed edge already
        // sits at/beyond the domain edge keeps its floor rather than collapsing to zero.
        if handle.movesLeftEdge {
            minX = min(minX + dx, maxX - minExtent)
            minX = min(max(minX, Int32(Int16.min), maxX - Int32(Int16.max)), maxX - minExtent)
        }
        if handle.movesRightEdge {
            maxX = max(maxX + dx, minX + minExtent)
            maxX = max(min(maxX, Int32(Int16.max), minX + Int32(Int16.max)), minX + minExtent)
        }
        if handle.movesTopEdge {
            minY = min(minY + dy, maxY - minExtent)
            minY = min(max(minY, Int32(Int16.min), maxY - Int32(Int16.max)), maxY - minExtent)
        }
        if handle.movesBottomEdge {
            maxY = max(maxY + dy, minY + minExtent)
            maxY = max(min(maxY, Int32(Int16.max), minY + Int32(Int16.max)), minY + minExtent)
        }
        return (
            GridPoint(x: Int16(clamping: minX), y: Int16(clamping: minY)),
            GridSize(width: Int16(clamping: maxX - minX), height: Int16(clamping: maxY - minY))
        )
    }

    // swiftlint:enable function_parameter_count

    /// The 8 handle centers on a record's bounds, in legacy pixels — corners plus edge
    /// midpoints. Hit-testing projects these, and the workspace forwards the same centers
    /// to `AuthoringOverlay` for drawing, so the visible and grabbable handles cannot drift.
    static func handleCenters(origin: GridPoint, size: GridSize) -> [(handle: EditorResizeHandle, pixel: SIMD2<Float>)] {
        let minX = Float(origin.x)
        let minY = Float(origin.y)
        let maxX = minX + Float(size.width)
        let maxY = minY + Float(size.height)
        let midX = (minX + maxX) / 2
        let midY = (minY + maxY) / 2
        return [
            (.topLeft, SIMD2(minX, minY)), (.top, SIMD2(midX, minY)), (.topRight, SIMD2(maxX, minY)),
            (.left, SIMD2(minX, midY)), (.right, SIMD2(maxX, midY)),
            (.bottomLeft, SIMD2(minX, maxY)), (.bottom, SIMD2(midX, maxY)), (.bottomRight, SIMD2(maxX, maxY))
        ]
    }

    /// The handle under a viewport point, if any — each handle center is projected to
    /// screen space and hit-tested with a constant-point-size rect.
    static func hitHandle(
        at location: CGPoint,
        origin: GridPoint,
        size: GridSize,
        viewportSize: CGSize,
        framing: EditorFraming
    ) -> EditorResizeHandle? {
        for (handle, pixel) in handleCenters(origin: origin, size: size)
            where handleHitRect(aroundPixel: pixel, viewportSize: viewportSize, framing: framing).contains(location) {
            return handle
        }
        return nil
    }

    /// Constant-screen-size hit rect centered on a legacy pixel's viewport projection.
    static func handleHitRect(aroundPixel pixel: SIMD2<Float>, viewportSize: CGSize, framing: EditorFraming) -> CGRect {
        let projected = OrthographicCameraRig.viewportPoint(
            forLegacyPoint: pixel,
            viewportSize: SIMD2<Float>(viewportSize),
            framing: framing
        )
        return CGRect(
            x: CGFloat(projected.x) - handleHitExtentPt / 2,
            y: CGFloat(projected.y) - handleHitExtentPt / 2,
            width: handleHitExtentPt,
            height: handleHitExtentPt
        )
    }

    /// Viewport-space corners of a record's floor bounds, in edge order — the tilted camera
    /// maps the floor rect to a rotated convex quad on screen.
    static func projectedCorners(origin: GridPoint, size: GridSize, viewportSize: CGSize, framing: EditorFraming) -> [CGPoint] {
        let minX = Float(origin.x)
        let minY = Float(origin.y)
        let maxX = minX + Float(size.width)
        let maxY = minY + Float(size.height)
        let viewport = SIMD2<Float>(viewportSize)
        return [
            SIMD2<Float>(minX, minY), SIMD2<Float>(maxX, minY),
            SIMD2<Float>(maxX, maxY), SIMD2<Float>(minX, maxY)
        ].map { pixel in
            let projected = OrthographicCameraRig.viewportPoint(forLegacyPoint: pixel, viewportSize: viewport, framing: framing)
            return CGPoint(x: CGFloat(projected.x), y: CGFloat(projected.y))
        }
    }

    /// Every record whose projected quad intersects the marquee rect. The quad itself is
    /// tested (separating axes), not its bounding box — a rotated floor rect's bounding box
    /// covers far more screen than the record and would marquee-select across empty ground.
    static func marqueeSelections(
        in body: SectorBody,
        viewportRect rect: CGRect,
        viewportSize: CGSize,
        framing: EditorFraming
    ) -> Set<EditorSelection> {
        var hits: Set<EditorSelection> = []
        for candidate in CanvasController.candidateSelections(in: body, tool: .select) {
            guard let bounds = candidate.bounds(in: body) else { continue }
            let quad = projectedCorners(origin: bounds.origin, size: bounds.size, viewportSize: viewportSize, framing: framing)
            if rectIntersectsConvexQuad(rect, quad) {
                hits.insert(candidate)
            }
        }
        return hits
    }

    /// Separating-axis intersection between an axis-aligned rect and a convex quad given in
    /// edge order: the shapes overlap unless some axis — the rect's two, or a quad edge
    /// normal — separates their projections.
    static func rectIntersectsConvexQuad(_ rect: CGRect, _ quad: [CGPoint]) -> Bool {
        let rectCorners = [
            CGPoint(x: rect.minX, y: rect.minY), CGPoint(x: rect.maxX, y: rect.minY),
            CGPoint(x: rect.maxX, y: rect.maxY), CGPoint(x: rect.minX, y: rect.maxY)
        ]
        var axes = [CGPoint(x: 1, y: 0), CGPoint(x: 0, y: 1)]
        for index in quad.indices {
            let next = quad[(index + 1) % quad.count]
            axes.append(CGPoint(x: quad[index].y - next.y, y: next.x - quad[index].x))
        }
        for axis in axes {
            func span(_ points: [CGPoint]) -> (min: CGFloat, max: CGFloat) {
                let projections = points.map { $0.x * axis.x + $0.y * axis.y }
                return (projections.min() ?? 0, projections.max() ?? 0)
            }
            let rectSpan = span(rectCorners)
            let quadSpan = span(quad)
            if rectSpan.max < quadSpan.min || quadSpan.max < rectSpan.min {
                return false
            }
        }
        return true
    }

    /// Heading of the drag point around the NPC's spawn-box center, computed in legacy
    /// floor coordinates — the tilted camera rotates/scales the floor axes on screen, so a
    /// viewport-space vector would yield a wrong angle.
    static func heading(fromViewport location: CGPoint, npc: NPC, viewportSize: CGSize, framing: EditorFraming) -> Heading {
        let point = OrthographicCameraRig.legacyPoint(
            forViewport: SIMD2<Float>(location),
            viewportSize: SIMD2<Float>(viewportSize),
            framing: framing
        )
        let delta = point - spawnBoxCenter(origin: npc.spawnOrigin, size: npc.spawnBoxSize)
        guard delta != .zero else { return npc.facing }
        return Heading(dx: delta.x, dy: delta.y)
    }

    static func spawnBoxCenter(origin: GridPoint, size: GridSize) -> SIMD2<Float> {
        SIMD2<Float>(
            Float(origin.x) + Float(size.width) / 2,
            Float(origin.y) + Float(size.height) / 2
        )
    }

    /// The facing handle's legacy-pixel position: offset from the spawn-box center along
    /// the heading, cleared past the box's half extent so it never sits inside the rect.
    static func facingHandlePixel(origin: GridPoint, size: GridSize, heading: Heading, clearancePx: Float) -> SIMD2<Float> {
        let center = spawnBoxCenter(origin: origin, size: size)
        let halfExtent = Float(max(size.width, size.height)) / 2
        let direction = SIMD2<Float>(sin(heading.radians), cos(heading.radians))
        return center + direction * (halfExtent + clearancePx)
    }

    // MARK: - Record mutation

    /// Origin snapshot of every selected record, keyed by selection, taken at press time.
    static func origins(of selections: Set<EditorSelection>, in body: SectorBody) -> [EditorSelection: GridPoint] {
        var originals: [EditorSelection: GridPoint] = [:]
        for selection in selections {
            if let bounds = selection.bounds(in: body) {
                originals[selection] = bounds.origin
            }
        }
        return originals
    }

    /// Shifts every snapshotted origin by the quantized delta (widened, then clamped back
    /// into the `Int16` grid).
    static func applyMove(originals: [EditorSelection: GridPoint], dx: Int32, dy: Int32, to body: inout SectorBody) {
        for (selection, origin) in originals {
            guard selection.isValid(in: body) else { continue }
            let moved = GridPoint(
                x: Int16(clamping: Int32(origin.x) + dx),
                y: Int16(clamping: Int32(origin.y) + dy)
            )
            switch selection {
            case let .object(index):
                body.objects[index].x = moved.x
                body.objects[index].y = moved.y
            case let .mask(index):
                body.collisionMasks[index].x = moved.x
                body.collisionMasks[index].y = moved.y
            case let .portal(index):
                body.portals[index].x = moved.x
                body.portals[index].y = moved.y
            case let .npc(index):
                body.npcs[index].spawnOrigin = moved
            case let .monsterSpawn(index):
                body.monsterSpawns[index].spawnOrigin = moved
            }
        }
    }

    /// Writes resized bounds back to the selected record (an NPC/monster selection resizes
    /// its spawn box; the inspector refines the other size fields).
    static func applyBounds(_ selection: EditorSelection, origin: GridPoint, size: GridSize, to body: inout SectorBody) {
        switch selection {
        case let .object(index):
            guard body.objects.indices.contains(index) else { return }
            body.objects[index].x = origin.x
            body.objects[index].y = origin.y
            body.objects[index].sourceWidth = size.width
            body.objects[index].sourceHeight = size.height
        case let .mask(index):
            guard body.collisionMasks.indices.contains(index) else { return }
            body.collisionMasks[index].x = origin.x
            body.collisionMasks[index].y = origin.y
            body.collisionMasks[index].width = size.width
            body.collisionMasks[index].height = size.height
        case let .portal(index):
            guard body.portals.indices.contains(index) else { return }
            body.portals[index].x = origin.x
            body.portals[index].y = origin.y
            body.portals[index].width = size.width
            body.portals[index].height = size.height
        case let .npc(index):
            guard body.npcs.indices.contains(index) else { return }
            body.npcs[index].spawnOrigin = origin
            body.npcs[index].spawnBoxSize = size
        case let .monsterSpawn(index):
            guard body.monsterSpawns.indices.contains(index) else { return }
            body.monsterSpawns[index].spawnOrigin = origin
            body.monsterSpawns[index].spawnBoxSize = size
        }
    }

    /// Appends a freshly placed record with the default field values, returning its
    /// selection (the inspector then refines the fields in place).
    static func placeRecord(tool: EditorTool, origin: GridPoint, size: GridSize, into body: inout SectorBody) -> EditorSelection? {
        switch tool {
        case .select:
            return nil
        case .object:
            body.objects.append(Object(
                x: origin.x, y: origin.y, modelID: EditorDefaults.defaultObjectModelID,
                sourceWidth: size.width, sourceHeight: size.height, priority: 0
            ))
            return .object(body.objects.count - 1)
        case .mask:
            body.collisionMasks.append(CollisionMask(x: origin.x, y: origin.y, width: size.width, height: size.height))
            return .mask(body.collisionMasks.count - 1)
        case .portal:
            body.portals.append(SectorPortal(
                x: origin.x, y: origin.y, width: size.width, height: size.height,
                targetSectorName: "", direction: .outboundTrigger
            ))
            return .portal(body.portals.count - 1)
        case .npc:
            body.npcs.append(NPC(
                spawnOrigin: origin, spawnBoxSize: size, maskSize: defaultFootprint,
                name: "", figure: 0, facing: Heading(cardinal: .south), behaviorTag: 0, dialogScript: ""
            ))
            return .npc(body.npcs.count - 1)
        case .monster:
            body.monsterSpawns.append(MonsterSpawn(
                spawnOrigin: origin, spawnBoxSize: size, spawnedMonsterSize: defaultFootprint,
                name: "", figure: 0, bounded: true, spawnHP: 100, spawnBalance: 100, spawnMana: 100, aiScriptIndex: 0
            ))
            return .monsterSpawn(body.monsterSpawns.count - 1)
        }
    }

    static func placementDescription(for tool: EditorTool) -> String.LocalizationValue {
        switch tool {
        case .select, .object: return "Place object"
        case .mask: return "Place collision mask"
        case .portal: return "Place sector portal"
        case .npc: return "Place NPC"
        case .monster: return "Place monster spawn"
        }
    }
}
