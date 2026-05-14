import CoreGraphics
import Foundation
import SomnioCore
import SpriteKit

/// Renders a sector's ground tiles and object decals into `parent`. Three passes run
/// in order: ground tiling, object decals sorted by priority, and `zPosition` from
/// `Object.priority` so high-priority decals draw above low-priority ones.
@MainActor
func renderTiles(sector: Sector, into parent: SKNode, assets: any SpriteAssets) {
    let tileSize = CGFloat(SomnioConstants.tileSize)
    let width = Int(sector.dimensions.width)
    let height = Int(sector.dimensions.height)

    for row in 0 ..< height {
        for column in 0 ..< width {
            let node = SKSpriteNode()
            node.size = CGSize(width: tileSize, height: tileSize)
            node.position = CGPoint(x: CGFloat(column) * tileSize, y: CGFloat(row) * tileSize)
            node.anchorPoint = CGPoint(x: 0, y: 0)
            if let texture = assets.groundTexture(
                tilesetIndex: sector.ground.tilesetIndex,
                sourceX: sector.ground.sourceX,
                sourceY: sector.ground.sourceY
            ) {
                node.texture = texture
            }
            parent.addChild(node)
        }
    }

    let sortedObjects = sector.objects.sorted { $0.priority < $1.priority }
    for object in sortedObjects {
        let node = SKSpriteNode()
        node.size = CGSize(width: CGFloat(object.sourceWidth), height: CGFloat(object.sourceHeight))
        node.position = CGPoint(x: CGFloat(object.x), y: CGFloat(object.y))
        node.anchorPoint = CGPoint(x: 0, y: 0)
        node.zPosition = CGFloat(object.priority)
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
