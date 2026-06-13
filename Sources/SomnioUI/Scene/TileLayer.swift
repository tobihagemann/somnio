import CoreGraphics
import Foundation
import SomnioCore
import SpriteKit

/// Renders a sector's ground as one repeating tile map and its object decals into `parent`.
/// The ground is a single `SKTileMapNode` (the ground is uniform per sector); object decals
/// are sprites sorted by priority and depth-ordered via `zPosition` so high-priority decals
/// draw above low-priority ones.
@MainActor
func renderTiles(sector: Sector, into parent: SKNode, assets: any SpriteAssets) {
    let sectorHeightPx = CGFloat(sector.pixelHeight)

    // The ground is uniform per sector, so a single tile map filled with one tile group
    // covers it — no per-row Y-flip is needed (a uniform fill has no orientation). Skip the
    // tile map entirely when the asset pack is absent so the scene renders empty ground
    // rather than untextured rectangles.
    if let cell = assets.groundTexture(
        tilesetIndex: sector.ground.tilesetIndex,
        sourceX: sector.ground.sourceX,
        sourceY: sector.ground.sourceY
    ) {
        let cellPx = Int(SomnioConstants.groundCellSize)
        let tileSize = CGSize(width: cellPx, height: cellPx)
        let definition = SKTileDefinition(texture: cell, size: tileSize)
        let group = SKTileGroup(tileDefinition: definition)
        let tileSet = SKTileSet(tileGroups: [group])
        let map = SKTileMapNode(
            tileSet: tileSet,
            columns: Int(sector.pixelWidth) / cellPx,
            rows: Int(sector.pixelHeight) / cellPx,
            tileSize: tileSize,
            fillWith: group
        )
        // Anchor the grid's bottom-left at scene origin so its extent matches the legacy
        // ground span `[0, pixelWidth] × [0, pixelHeight]`. `zPosition` 0 sits below every
        // object/entity depth, which `ScreenDepth` floors at 1.
        map.anchorPoint = CGPoint(x: 0, y: 0)
        map.position = .zero
        map.zPosition = 0
        parent.addChild(map)
    }

    let sortedObjects = sector.objects.sorted { $0.priority < $1.priority }
    for object in sortedObjects {
        let node = SKSpriteNode()
        node.size = CGSize(width: CGFloat(object.sourceWidth), height: CGFloat(object.sourceHeight))
        node.position = CGPoint(
            x: CGFloat(object.x),
            y: sectorHeightPx - CGFloat(object.y) - CGFloat(object.sourceHeight)
        )
        node.anchorPoint = CGPoint(x: 0, y: 0)
        node.zPosition = ScreenDepth.object(
            legacyY: CGFloat(object.y),
            height: CGFloat(object.sourceHeight),
            priority: object.priority
        )
        if let texture = assets.objectTexture(
            tilesetIndex: object.tilesetIndex,
            sourceX: object.sourceX,
            sourceY: object.sourceY,
            sourceWidth: object.sourceWidth,
            sourceHeight: object.sourceHeight
        ) {
            node.texture = texture
        }
        parent.addChild(node)
    }
}
