import AppKit
import Foundation
import RealityKit
import simd
import SomnioCore

/// Editor-only authoring overlay: flat unlit rects laid on the floor for the authored record
/// geometry (collision masks, portals, NPC and monster spawns), a border highlight for the
/// active selection, and an optional grid. Rebuilt from scratch on every update because the
/// per-refresh allocation cost is negligible at editor scale (a sector tops out at a few
/// hundred records) and diffing would couple the overlay to the `SectorBody` Equatable shape.
///
/// Records are authored in legacy top-left pixel space, which
/// `OrthographicCameraRig.worldPosition` maps directly onto the floor plane — there is no
/// Y-flip in the 3D path (that was a SpriteKit bottom-left-origin artifact).
extension WorldScene3D {
    /// Per-layer lift off the floor plane, in world units, so the overlay never z-fights the
    /// floor material and later layers draw over earlier ones.
    private enum OverlayElevation {
        static let masks: Float = 0.002
        static let portals: Float = 0.004
        static let spawns: Float = 0.006
        static let grid: Float = 0.008
        static let selection: Float = 0.010
    }

    private static let selectionBorderThicknessPx: Float = 2
    private static let gridLineThicknessPx: Float = 1
    private static let gridEntityName = "authoring-grid"
    /// The rebuild-from-scratch cost model holds for record rects (a few hundred per sector)
    /// but grid lines scale with sector pixels ÷ snap step, so a huge sector at the finest
    /// snap would emit tens of thousands of planes per refresh. Past this cap the grid is
    /// skipped — at that density it is unreadable noise anyway.
    private static let maxGridLines = 512

    /// Replaces the authoring overlay with the given body's record geometry. Parameters are
    /// SomnioCore-only: the editor resolves its selection to `(GridPoint, GridSize)` bounds
    /// before the call, since its selection type lives above this module. No-op until a
    /// sector is loaded.
    public func updateAuthoringOverlay(
        body: SectorBody,
        selectionBounds: (origin: GridPoint, size: GridSize)?,
        showGridOverlay: Bool,
        gridStepPx: Int16
    ) {
        guard let overlay = resolvedAuthoringOverlayRoot() else { return }
        for child in Array(overlay.children) {
            child.removeFromParent()
        }

        for mask in body.collisionMasks {
            overlay.addChild(Self.filledRect(
                origin: GridPoint(x: mask.x, y: mask.y),
                size: GridSize(width: mask.width, height: mask.height),
                color: .red, opacity: 0.25, elevation: OverlayElevation.masks
            ))
        }
        for portal in body.portals {
            let color: NSColor = portal.direction == .outboundTrigger ? .blue : .systemTeal
            overlay.addChild(Self.filledRect(
                origin: GridPoint(x: portal.x, y: portal.y),
                size: GridSize(width: portal.width, height: portal.height),
                color: color, opacity: 0.2, elevation: OverlayElevation.portals
            ))
        }
        for npc in body.npcs {
            overlay.addChild(Self.filledRect(
                origin: npc.spawnOrigin, size: npc.spawnBoxSize,
                color: .green, opacity: 0.2, elevation: OverlayElevation.spawns
            ))
        }
        for spawn in body.monsterSpawns {
            overlay.addChild(Self.filledRect(
                origin: spawn.spawnOrigin, size: spawn.spawnBoxSize,
                color: .orange, opacity: 0.2, elevation: OverlayElevation.spawns
            ))
        }

        if showGridOverlay, let grid = Self.gridLines(sectorSize: body.dimensions, stepPx: gridStepPx) {
            overlay.addChild(grid)
        }

        if let selectionBounds {
            overlay.addChild(Self.selectionBorder(origin: selectionBounds.origin, size: selectionBounds.size))
        }
    }

    /// Translucent unlit plane over a record's authored pixel rect. Zero/negative extents
    /// (an invalidated record mid-edit) yield an empty placeholder entity rather than a trap.
    private static func filledRect(
        origin: GridPoint,
        size: GridSize,
        color: NSColor,
        opacity: Float,
        elevation: Float
    ) -> Entity {
        floorPlane(
            centerPixel: SIMD2<Float>(
                Float(origin.x) + Float(size.width) / 2,
                Float(origin.y) + Float(size.height) / 2
            ),
            sizePx: SIMD2<Float>(Float(size.width), Float(size.height)),
            color: color, opacity: opacity, elevation: elevation
        )
    }

    /// Four opaque yellow strips outlining the selection bounds — a border rather than a fill
    /// so the highlight stays readable over the record's own filled rect.
    private static func selectionBorder(origin: GridPoint, size: GridSize) -> Entity {
        let border = Entity()
        let minX = Float(origin.x)
        let minY = Float(origin.y)
        let width = Float(size.width)
        let height = Float(size.height)
        let thickness = selectionBorderThicknessPx
        let edges: [(center: SIMD2<Float>, sizePx: SIMD2<Float>)] = [
            (SIMD2(minX + width / 2, minY), SIMD2(width + thickness, thickness)),
            (SIMD2(minX + width / 2, minY + height), SIMD2(width + thickness, thickness)),
            (SIMD2(minX, minY + height / 2), SIMD2(thickness, height + thickness)),
            (SIMD2(minX + width, minY + height / 2), SIMD2(thickness, height + thickness))
        ]
        for edge in edges {
            border.addChild(floorPlane(
                centerPixel: edge.center, sizePx: edge.sizePx,
                color: .yellow, opacity: 1, elevation: OverlayElevation.selection
            ))
        }
        return border
    }

    /// `nil` (⇒ no grid child at all) for degenerate inputs or when the line count would
    /// exceed `maxGridLines`, so overlay child counts stay meaningful around the cap.
    private static func gridLines(sectorSize: GridSize, stepPx: Int16) -> Entity? {
        let widthPx = Float(sectorSize.width) * Float(SomnioConstants.tileSize)
        let heightPx = Float(sectorSize.height) * Float(SomnioConstants.tileSize)
        let step = Float(stepPx)
        guard step > 0, widthPx > 0, heightPx > 0 else { return nil }
        guard Int((widthPx + heightPx) / step) + 2 <= maxGridLines else { return nil }
        let grid = Entity()
        grid.name = gridEntityName
        var x: Float = 0
        while x <= widthPx {
            grid.addChild(floorPlane(
                centerPixel: SIMD2(x, heightPx / 2), sizePx: SIMD2(gridLineThicknessPx, heightPx),
                color: .white, opacity: 0.15, elevation: OverlayElevation.grid
            ))
            x += step
        }
        var y: Float = 0
        while y <= heightPx {
            grid.addChild(floorPlane(
                centerPixel: SIMD2(widthPx / 2, y), sizePx: SIMD2(widthPx, gridLineThicknessPx),
                color: .white, opacity: 0.15, elevation: OverlayElevation.grid
            ))
            y += step
        }
        return grid
    }

    private static func floorPlane(
        centerPixel: SIMD2<Float>,
        sizePx: SIMD2<Float>,
        color: NSColor,
        opacity: Float,
        elevation: Float
    ) -> Entity {
        guard sizePx.x > 0, sizePx.y > 0 else { return Entity() }
        var material = UnlitMaterial(color: color)
        material.blending = .transparent(opacity: .init(floatLiteral: opacity))
        let plane = ModelEntity(
            mesh: .generatePlane(
                width: sizePx.x * OrthographicCameraRig.worldUnitsPerPixel,
                depth: sizePx.y * OrthographicCameraRig.worldUnitsPerPixel
            ),
            materials: [material]
        )
        var position = OrthographicCameraRig.worldPosition(forLegacyPoint: centerPixel)
        position.y = elevation
        plane.position = position
        return plane
    }

    /// Authoring-overlay test seam (mirrors `_sectorRootChildCount`): the overlay container's
    /// direct child count, or `nil` before the first update / after a load reset it.
    func _authoringOverlayChildCount() -> Int? {
        authoringOverlayRoot.map(\.children.count)
    }

    /// Geometry test seam: positions of the overlay's direct children (record rects sit at
    /// their world center + elevation; the grid/selection containers sit at the origin), so
    /// tests can pin the placement math, not just the child count.
    func _authoringOverlayChildPositions() -> [SIMD3<Float>]? {
        authoringOverlayRoot.map { $0.children.map(\.position) }
    }

    /// Grid test seam: the grid container's line count, or `nil` when no grid is present
    /// (toggled off, degenerate input, or suppressed by the `maxGridLines` cap).
    func _authoringOverlayGridLineCount() -> Int? {
        authoringOverlayRoot?.children.first { $0.name == Self.gridEntityName }?.children.count
    }
}
