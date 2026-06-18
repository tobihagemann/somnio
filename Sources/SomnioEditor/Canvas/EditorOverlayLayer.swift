import CoreGraphics
import Foundation
import SomnioCore
import SpriteKit

/// Editor-only SpriteKit overlay layered on top of the shared `WorldScene`. Renders
/// authored record geometry (masks, portals, NPC and monster spawns), the selection
/// highlight, and the optional grid overlay. Editor-scoped so the player client's
/// `WorldScene` continues to render only ground tiles, object sprites, and entities.
///
/// All four record-group nodes are rebuilt from scratch on every `refresh(...)` because
/// the per-tick allocation cost is negligible at editor scale (a sector tops out at a
/// few hundred records) and the alternative — diffing — would couple the layer to the
/// `SectorBody` Equatable shape.
@MainActor public final class EditorOverlayLayer {
    public let rootNode: SKNode
    private let masksNode = SKNode()
    private let portalsNode = SKNode()
    private let spawnsNode = SKNode()
    private let selectionNode = SKNode()
    private let gridNode = SKNode()

    public init() {
        self.rootNode = SKNode()
        rootNode.zPosition = 500
        rootNode.addChild(masksNode)
        rootNode.addChild(portalsNode)
        rootNode.addChild(spawnsNode)
        rootNode.addChild(gridNode)
        rootNode.addChild(selectionNode)
    }

    // swiftlint:disable:next function_body_length
    public func refresh(
        with body: SectorBody,
        selection: EditorSelection?,
        showGridOverlay: Bool,
        gridStepPx: Int16
    ) {
        masksNode.removeAllChildren()
        portalsNode.removeAllChildren()
        spawnsNode.removeAllChildren()
        gridNode.removeAllChildren()
        selectionNode.removeAllChildren()

        // Records are authored in legacy top-left pixel space; the ground/object graphics are
        // rendered Y-flipped to SpriteKit's bottom-left origin (see `WorldScene.sceneY`), so the
        // overlay has to flip by the same sector pixel height or the masks land mirrored against
        // the art they describe.
        let sectorHeightPx = CGFloat(body.pixelHeight)

        for mask in body.collisionMasks {
            masksNode.addChild(filledRectangle(
                origin: GridPoint(x: mask.x, y: mask.y),
                size: GridSize(width: mask.width, height: mask.height),
                fill: SKColor.red.withAlphaComponent(0.25),
                stroke: .red,
                sectorHeightPx: sectorHeightPx
            ))
        }
        for portal in body.portals {
            let stroke: SKColor = portal.direction == .outboundTrigger ? .blue : .systemTeal
            let origin = GridPoint(x: portal.x, y: portal.y)
            let size = GridSize(width: portal.width, height: portal.height)
            let rect = filledRectangle(
                origin: origin,
                size: size,
                fill: stroke.withAlphaComponent(0.2),
                stroke: stroke,
                sectorHeightPx: sectorHeightPx
            )
            rect.addChild(label(text: portal.targetSectorName, at: origin, sectorHeightPx: sectorHeightPx))
            portalsNode.addChild(rect)
        }
        for npc in body.npcs {
            let rect = filledRectangle(
                origin: npc.spawnOrigin,
                size: npc.spawnBoxSize,
                fill: SKColor.green.withAlphaComponent(0.2),
                stroke: .green,
                sectorHeightPx: sectorHeightPx
            )
            rect.addChild(label(text: npc.name, at: npc.spawnOrigin, sectorHeightPx: sectorHeightPx))
            spawnsNode.addChild(rect)
        }
        for spawn in body.monsterSpawns {
            let rect = filledRectangle(
                origin: spawn.spawnOrigin,
                size: spawn.spawnBoxSize,
                fill: SKColor.orange.withAlphaComponent(0.2),
                stroke: .orange,
                sectorHeightPx: sectorHeightPx
            )
            rect.addChild(label(text: spawn.name, at: spawn.spawnOrigin, sectorHeightPx: sectorHeightPx))
            spawnsNode.addChild(rect)
        }

        if let selection {
            if let highlight = highlightShape(for: selection, in: body, sectorHeightPx: sectorHeightPx) {
                selectionNode.addChild(highlight)
            }
        }

        if showGridOverlay, gridStepPx > 0 {
            renderGrid(into: gridNode, sectorSize: body.dimensions, stepPx: gridStepPx)
        }
    }

    /// `CGRect` for a record authored at legacy top-left `origin`/`size`, flipped into the scene's
    /// bottom-left space (the same flip the ground/object art uses).
    private func flippedRect(origin: GridPoint, size: GridSize, sectorHeightPx: CGFloat) -> CGRect {
        CGRect(
            x: CGFloat(origin.x),
            y: sectorHeightPx - CGFloat(origin.y) - CGFloat(size.height),
            width: CGFloat(size.width),
            height: CGFloat(size.height)
        )
    }

    private func filledRectangle(
        origin: GridPoint,
        size: GridSize,
        fill: SKColor,
        stroke: SKColor,
        sectorHeightPx: CGFloat
    ) -> SKShapeNode {
        let shape = SKShapeNode(rect: flippedRect(origin: origin, size: size, sectorHeightPx: sectorHeightPx))
        shape.fillColor = fill
        shape.strokeColor = stroke
        shape.lineWidth = 1
        return shape
    }

    private func label(text: String, at origin: GridPoint, sectorHeightPx: CGFloat) -> SKLabelNode {
        let node = SKLabelNode(text: text)
        node.fontName = "Menlo"
        node.fontSize = 10
        node.fontColor = .white
        node.horizontalAlignmentMode = .left
        node.verticalAlignmentMode = .top
        // Pin to the box's visual top-left edge in the flipped scene space (the box top is the
        // higher scene Y), 2px in, so the label still reads from the corner the user authored.
        node.position = CGPoint(x: CGFloat(origin.x) + 2, y: sectorHeightPx - CGFloat(origin.y) - 2)
        return node
    }

    private func highlightShape(for selection: EditorSelection, in body: SectorBody, sectorHeightPx: CGFloat) -> SKShapeNode? {
        guard let (origin, size) = selection.bounds(in: body) else { return nil }
        let shape = SKShapeNode(rect: flippedRect(origin: origin, size: size, sectorHeightPx: sectorHeightPx))
        shape.fillColor = .clear
        shape.strokeColor = .yellow
        shape.lineWidth = 2
        return shape
    }

    private func renderGrid(into parent: SKNode, sectorSize: GridSize, stepPx: Int16) {
        let widthPx = CGFloat(sectorSize.width) * CGFloat(SomnioConstants.tileSize)
        let heightPx = CGFloat(sectorSize.height) * CGFloat(SomnioConstants.tileSize)
        let step = CGFloat(stepPx)
        guard step > 0, widthPx > 0, heightPx > 0 else { return }
        let path = CGMutablePath()
        var x: CGFloat = 0
        while x <= widthPx {
            path.move(to: CGPoint(x: x, y: 0))
            path.addLine(to: CGPoint(x: x, y: heightPx))
            x += step
        }
        var y: CGFloat = 0
        while y <= heightPx {
            path.move(to: CGPoint(x: 0, y: y))
            path.addLine(to: CGPoint(x: widthPx, y: y))
            y += step
        }
        let shape = SKShapeNode(path: path)
        shape.strokeColor = SKColor.white.withAlphaComponent(0.15)
        shape.lineWidth = 0.5
        parent.addChild(shape)
    }
}
