import CoreGraphics
import Foundation
import Logging
import SomnioCore
import SpriteKit

/// SpriteKit scene that renders the world inside the play-field viewport. State lives
/// across multiple sectors: `load(sector:)` swaps the rendered ground/objects, the
/// entity-node map is rebuilt per sector (the wire's sector-local `entityIndex` may
/// be reused after a sector switch), and the day/night tint pass updates with each
/// `DateTick`. Splash is the scene's initial state until the first `EnterSector`
/// frame arrives.
@MainActor public final class WorldScene: SKScene {
    private static let logger = Logger(label: "de.tobiha.somnio.ui.scene")

    private let assets: any SpriteAssets
    private var sectorRoot: SKNode?
    private var splashNode: SKSpriteNode?
    private var tintNode: SKSpriteNode?
    private var entityNodes: [Int16: SKSpriteNode] = [:]
    private var bubbleNodes: [Int16: SpeechBubbleNode] = [:]

    public init(size: CGSize, assets: any SpriteAssets) {
        self.assets = assets
        super.init(size: size)
        anchorPoint = CGPoint(x: 0, y: 0)
        scaleMode = .resizeFill
        showSplash()
    }

    @available(*, unavailable)
    public required init?(coder _: NSCoder) {
        fatalError("WorldScene must be created with init(size:assets:)")
    }

    public func load(sector: Sector) {
        splashNode?.removeFromParent()
        splashNode = nil
        sectorRoot?.removeFromParent()
        entityNodes.removeAll()
        bubbleNodes.removeAll()

        let root = SKNode()
        renderTiles(sector: sector, into: root, assets: assets)
        addChild(root)
        sectorRoot = root
    }

    public func placeEntity(_ entity: WorldEntity) {
        let tileSize = CGFloat(SomnioConstants.tileSize)
        let node = entityNodes[entity.id] ?? SKSpriteNode()
        node.size = CGSize(width: tileSize, height: tileSize)
        node.position = CGPoint(x: CGFloat(entity.position.x), y: CGFloat(entity.position.y))
        node.anchorPoint = CGPoint(x: 0, y: 0)
        node.zPosition = 100
        if entityNodes[entity.id] == nil {
            sectorRoot?.addChild(node)
            entityNodes[entity.id] = node
        }
    }

    public func updatePosition(entityID: Int16, to position: GridPoint, facing _: Direction) {
        guard let node = entityNodes[entityID] else {
            WorldScene.logger.debug("updatePosition called for unknown entity \(entityID)")
            return
        }
        node.position = CGPoint(x: CGFloat(position.x), y: CGFloat(position.y))
    }

    public func showSpeechBubble(above entityID: Int16, text: String, lifetime: TimeInterval) {
        guard let anchor = entityNodes[entityID] else { return }
        bubbleNodes[entityID]?.removeFromParent()
        let bubble = SpeechBubbleNode(lines: [text], lifetime: lifetime)
        bubble.position = CGPoint(x: anchor.position.x, y: anchor.position.y + anchor.size.height)
        sectorRoot?.addChild(bubble)
        bubbleNodes[entityID] = bubble
    }

    public func updateDayNightTint(hour: Int16, minute: Int16, sectorLight: LightSetting) {
        let ambient = DayNightTint.ambientLight(hour: hour, minute: minute, sectorLight: sectorLight)
        let alpha = max(0, min(1, 1 - ambient / 100))
        let tint = tintNode ?? makeTintNode()
        tint.alpha = alpha
    }

    public func showSplash() {
        sectorRoot?.removeFromParent()
        sectorRoot = nil
        entityNodes.removeAll()
        bubbleNodes.removeAll()
        let node = splashNode ?? SKSpriteNode()
        node.size = size
        node.position = CGPoint(x: 0, y: 0)
        node.anchorPoint = CGPoint(x: 0, y: 0)
        node.zPosition = 0
        if let texture = assets.splash() {
            node.texture = texture
        }
        if splashNode == nil {
            addChild(node)
            splashNode = node
        }
    }

    private func makeTintNode() -> SKSpriteNode {
        let node = SKSpriteNode(color: .black, size: size)
        node.anchorPoint = CGPoint(x: 0, y: 0)
        node.position = CGPoint(x: 0, y: 0)
        node.zPosition = 1000
        node.alpha = 0
        node.blendMode = .alpha
        addChild(node)
        tintNode = node
        return node
    }
}
